"""Synthetic bytes only. Run on the hosted inventory job, never on the owner Mac."""

import contextlib
import hashlib
import io
import json
import os
import stat
import struct
import tempfile
import time
import unittest
import urllib.error
import warnings
import zipfile
from pathlib import Path
from unittest.mock import patch

import inventory_qa_zip as subject

MARKER = "UNEXPECTED_PRIVATE_MARKER"
REGULAR = stat.S_IFREG | 0o644
LINK = stat.S_IFLNK | 0o777


def zip_bytes(rows, output=None):
    output = output or io.BytesIO()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")  # Deliberate duplicate fixtures, not production handling.
        with zipfile.ZipFile(output, "w") as zipped:
            for row in rows:
                name, payload, mode = row[:3]
                entry = zipfile.ZipInfo(name)
                entry.create_system = 3
                entry.external_attr = mode << 16
                entry.compress_type = zipfile.ZIP_DEFLATED
                entry.extra = row[3] if len(row) > 3 else b""
                entry.comment = MARKER.encode()
                zipped.writestr(entry, payload)
    return output.getvalue()


class Response(io.BytesIO):
    status = 200


class Transport:
    def __init__(self, replies):
        self.replies = list(replies)
        self.requests = []

    def open(self, request, timeout):
        self.requests.append(request)
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply


class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name).resolve()
        self.deadline = time.monotonic() + 60
        self.network = patch("socket.create_connection", side_effect=AssertionError("Network forbidden in tests"))
        self.network.start()

    def tearDown(self):
        self.network.stop()
        self.temporary.cleanup()

    def archive(self, rows):
        path = self.base / "fixture.zip"
        path.write_bytes(zip_bytes(rows))
        return path

    def root(self):
        root = Path(tempfile.mkdtemp(prefix=subject.ROOT_PREFIX, dir=self.base))
        (root / ".owner").write_bytes(subject.OWNER_MARKER)
        return root

    def env(self):
        return {"RUNNER_TEMP": str(self.base), "GITHUB_ACTIONS": "true",
                "RUNNER_ENVIRONMENT": "github-hosted", "GITHUB_REPOSITORY": subject.REPOSITORY,
                "GITHUB_SHA": "a" * 40, "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1"}

    def provenance(self, inner=b"synthetic"):
        asset = {"name": "Metis-QA-1.9.7.zip", "size": len(inner),
                 "sha256": hashlib.sha256(inner).hexdigest()}
        return {"schema": 1, "repository": subject.REPOSITORY, "commit": subject.CANDIDATE_SHA,
                "run": {"id": subject.CANDIDATE_RUN}, "version": "1.9.7", "builds": [
                    {"variant": subject.VARIANT, "artifact": "candidate-mac-qa-identity", "assets": [asset]}]}

    def api_records(self):
        run = {"id": subject.CANDIDATE_RUN, "repository": {"id": subject.REPOSITORY_ID, "full_name": subject.REPOSITORY},
               "head_repository": {"id": subject.REPOSITORY_ID}, "head_sha": subject.CANDIDATE_SHA,
               "head_branch": "main", "path": ".github/workflows/qa-candidate.yml", "event": "workflow_dispatch",
               "status": "completed", "conclusion": "success"}
        records = [{"id": artifact_id, "name": name, "expired": False, "expires_at": "2999-01-01T00:00:00Z",
                    "size_in_bytes": 100, "digest": "sha256:" + "b" * 64,
                    "workflow_run": {"id": subject.CANDIDATE_RUN, "head_sha": subject.CANDIDATE_SHA,
                                     "repository_id": subject.REPOSITORY_ID, "head_repository_id": subject.REPOSITORY_ID}}
                   for artifact_id, name in subject.ARTIFACTS.values()]
        return run, {"total_count": len(records), "artifacts": records}

    def cli(self, root, side_effect=None):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.ExitStack() as stack:
            stack.enter_context(contextlib.redirect_stdout(out))
            stack.enter_context(contextlib.redirect_stderr(err))
            stack.enter_context(patch.object(subject.resource, "setrlimit"))
            stack.enter_context(patch.object(subject.signal, "alarm"))
            if side_effect is not None:
                stack.enter_context(patch.object(subject, "inventory_download", side_effect=side_effect))
            result = subject.cli(["inventory", str(root)], self.env())
        report = (root / "inventory.json").read_text() if (root / "inventory.json").exists() else ""
        self.assertNotIn(MARKER, out.getvalue() + err.getvalue() + report)
        return result, report

    def test_real_framework_metadata_and_bounded_link_traits(self):
        path = self.archive([
            ("Metis QA.app/Contents/MacOS/Metis QA", b"not executable code", stat.S_IFREG | 0o755),
            ("Metis QA.app/Contents/Frameworks/Example.framework/Versions/A/Example", b"binary", REGULAR),
            ("Metis QA.app/Contents/Frameworks/Example.framework/Versions/Current", b"A", LINK),
            ("Metis QA.app/Contents/Frameworks/Example.framework/Example", b"Versions/Current/Example", LINK)])
        report = subject.inventory(path, self.deadline)
        self.assertEqual(report["status"], "COMPLETE")
        self.assertEqual(report["counts"]["entries"], 4)
        self.assertEqual(report["counts"]["relativeLinkTargets"], 2)
        self.assertEqual(report["counts"]["linkPayloadsRead"], 2)
        self.assertEqual(report["distributions"]["unixModes"]["0755"], 1)
        self.assertEqual(report["linkGraph"], "NOT_ANALYSED")
        self.assertEqual(report["linkResolutionUnknownCount"], 2)
        self.assertNotIn(MARKER, json.dumps(report))

    def test_duplicates_ascii_case_and_traversal_are_counts_not_paths(self):
        names = ["Metis QA.app/A", "Metis QA.app/A", "Metis QA.app/a", "../" + MARKER]
        report = subject.inventory(self.archive([(name, b"x", REGULAR) for name in names]), self.deadline)
        self.assertEqual(report["counts"]["duplicateNames"], 1)
        self.assertEqual(report["counts"]["asciiCaseConflicts"], 1)
        self.assertEqual(report["counts"]["traversalNames"], 1)
        self.assertEqual(report["status"], "INCOMPLETE")
        self.assertNotIn(MARKER, json.dumps(report))

    def test_link_traits_do_not_claim_recursive_resolution(self):
        report = subject.inventory(self.archive([
            ("Metis QA.app/a", b"b", LINK), ("Metis QA.app/b", b"a", LINK),
            ("Metis QA.app/missing", b"does-not-exist", LINK),
            ("Metis QA.app/outside", b"../../" + MARKER.encode(), LINK),
            ("Metis QA.app/absolute", b"/" + MARKER.encode(), LINK),
            ("Metis QA.app/a/child", b"x", REGULAR)]), self.deadline)
        self.assertEqual(report["counts"]["absoluteLinkTargets"], 1)
        self.assertEqual(report["counts"]["linkTargetsWithParentComponents"], 1)
        self.assertEqual(report["counts"]["symlinkAncestorEntries"], 1)
        self.assertEqual(report["linkGraph"], "NOT_ANALYSED")
        self.assertEqual(report["linkResolutionUnknownCount"], 5)
        self.assertNotIn(MARKER, json.dumps(report))

    def test_extra_ids_and_zip64_are_indicators_not_format_admission(self):
        extra = struct.pack("<HHQQ", 1, 16, 1, 1) + struct.pack("<HH", 0xCAFE, len(MARKER)) + MARKER.encode()
        report = subject.inventory(self.archive([("Metis QA.app/a", b"x", REGULAR, extra)]), self.deadline)
        self.assertEqual(report["distributions"]["extraIds"], {"0001": 1, "cafe": 1})
        self.assertEqual(report["counts"]["zip64ExtraFields"], 1)
        self.assertEqual(report["localHeaders"], "NOT_INSPECTED")
        self.assertNotIn(MARKER, json.dumps(report))

    def test_data_descriptor_is_observed_from_real_streamed_zip(self):
        class Unseekable(io.BytesIO):
            def seek(self, *args):
                raise io.UnsupportedOperation()
        path = self.base / "descriptor.zip"
        path.write_bytes(zip_bytes([("Metis QA.app/a", b"x", REGULAR)], Unseekable()))
        self.assertEqual(subject.inventory(path, self.deadline)["counts"]["descriptorFlagEntries"], 1)

    def test_local_only_zip64_is_explicitly_not_inspected(self):
        data = io.BytesIO()
        with zipfile.ZipFile(data, "w") as zipped:
            with zipped.open("Metis QA.app/a", "w", force_zip64=True) as member:
                member.write(b"x")
        path = self.base / "local64.zip"
        path.write_bytes(data.getvalue())
        report = subject.inventory(path, self.deadline)
        self.assertEqual(report["counts"]["zip64ExtraFields"], 0)
        self.assertEqual(report["localHeaders"], "NOT_INSPECTED")

    def test_unknown_link_encoding_and_link_limits_are_incomplete(self):
        rows = [("Metis QA.app/nonascii", "é".encode(), LINK),
                ("Metis QA.app/large", b"x" * (subject.MAX_LINK + 1), LINK)]
        report = subject.inventory(self.archive(rows), self.deadline)
        self.assertEqual(report["status"], "INCOMPLETE")
        self.assertEqual(report["counts"]["unknownLinkEncoding"], 1)
        self.assertEqual(report["counts"]["unreadLinkPayloads"], 1)
        with patch.object(subject, "MAX_LINK_TOTAL", 0):
            limited = subject.inventory(self.archive([("Metis QA.app/a", b"b", LINK)]), self.deadline)
        self.assertEqual(limited["counts"]["unreadLinkPayloads"], 1)

    def test_legacy_nonascii_name_is_not_assumed_utf8(self):
        raw = zip_bytes([("Metis QA.app/z", b"x", REGULAR)])
        raw = raw.replace(b"Metis QA.app/z", b"Metis QA.app/\x82")
        path = self.base / "legacy.zip"
        path.write_bytes(raw)
        report = subject.inventory(path, self.deadline)
        self.assertEqual(report["counts"]["legacyNonAsciiNames"], 1)
        self.assertEqual(report["status"], "INCOMPLETE")

    def test_invalid_utf8_and_malformed_extras_do_not_become_assumed_metadata(self):
        raw = bytearray(zip_bytes([("Metis QA.app/z", b"x", REGULAR)]))
        for magic, flag_offset in ((b"PK\x03\x04", 6), (b"PK\x01\x02", 8)):
            offset = raw.index(magic)
            struct.pack_into("<H", raw, offset + flag_offset, 0x800)
        raw = raw.replace(b"Metis QA.app/z", b"Metis QA.app/\xff")
        path = self.base / "invalid.zip"
        path.write_bytes(raw)
        with self.assertRaises(Exception):
            subject.inventory(path, self.deadline)
        path = self.archive([("Metis QA.app/a", b"x", REGULAR, b"\x01\x00\xff\xff")])
        with self.assertRaises(Exception):
            subject.inventory(path, self.deadline)

    def test_metadata_allocation_is_refused_before_underlying_read(self):
        class NeverRead(io.BytesIO):
            def read(self, size=-1):
                raise AssertionError("Oversized read delegated")
        reader = subject.MetadataReader(NeverRead(b"x" * 100), cap=10)
        with self.assertRaises(subject.InventoryError):
            reader.read(11)
        with self.assertRaises(subject.InventoryError):
            reader.read()

    def test_entry_count_and_deadline_are_enforced(self):
        path = self.archive([("Metis QA.app/a", b"x", REGULAR)])
        with patch.object(subject, "MAX_ENTRIES", 0), self.assertRaises(subject.InventoryError):
            subject.inventory(path, self.deadline)
        with self.assertRaises(subject.InventoryError):
            subject.inventory(path, time.monotonic() - 1)

    def test_stream_cap_checks_actual_bytes_before_writing_overrun(self):
        sink = io.BytesIO()
        with self.assertRaises(subject.InventoryError):
            subject.copy_bounded(io.BytesIO(b"too long"), sink, 2, self.deadline)
        self.assertLessEqual(len(sink.getvalue()), 2)

    def test_ordinary_inner_payloads_are_not_opened(self):
        path = self.archive([("Metis QA.app/a", b"secret contents", REGULAR)])
        with patch.object(zipfile.ZipFile, "open", side_effect=AssertionError("No ordinary payload reads")):
            self.assertEqual(subject.inventory(path, self.deadline)["status"], "COMPLETE")

    def test_strict_outer_allowlist_rejects_wrong_names_duplicates_and_links(self):
        for rows in ([('../' + MARKER, b"x", REGULAR)],
                     [("expected.zip", b"x", REGULAR), ("expected.zip", b"y", REGULAR)],
                     [("expected.zip", b"target", LINK)]):
            with self.subTest(kind=len(rows)):
                path = self.archive(rows)
                with subject.archive(path) as zipped, self.assertRaises(subject.InventoryError):
                    subject.outer_entries(zipped, ["expected.zip"])

    def test_outer_nul_name_cannot_be_silently_truncated(self):
        raw = zip_bytes([("expected.zipQ", b"x", REGULAR)])
        path = self.base / "nul.zip"
        path.write_bytes(raw.replace(b"expected.zipQ", b"expected.zip\x00"))
        with subject.archive(path) as zipped, self.assertRaises(subject.InventoryError):
            subject.outer_entries(zipped, ["expected.zip"])

    def test_api_binding_requires_run_repository_commit_unique_ids_digest_and_expiry(self):
        run, listing = self.api_records()
        self.assertEqual(set(subject.validate_api(run, listing)), {"qa", "provenance"})
        for field, value in (("head_sha", "c" * 40), ("id", 1), ("conclusion", "failure")):
            with self.subTest(field=field), self.assertRaises(subject.InventoryError):
                subject.validate_api({**run, field: value}, listing)
        for change in ({"expired": True}, {"digest": ""}, {"size_in_bytes": subject.MAX_ARCHIVE + 1},
                       {"expires_at": "2000-01-01T00:00:00Z"}):
            bad = {**listing, "artifacts": [{**listing["artifacts"][0], **change}, listing["artifacts"][1]]}
            with self.subTest(change=next(iter(change))), self.assertRaises(subject.InventoryError):
                subject.validate_api(run, bad)
        duplicate = listing["artifacts"] + [listing["artifacts"][0]]
        with self.assertRaises(subject.InventoryError):
            subject.validate_api(run, {"total_count": 3, "artifacts": duplicate})

    def test_provenance_uses_hoisted_schema1_fields_and_unique_variant(self):
        good = self.provenance()
        self.assertEqual(subject.provenance_asset(good)["name"], "Metis-QA-1.9.7.zip")
        for field, value in (("repository", "wrong/repository"), ("commit", "c" * 40),
                             ("run", {"id": 1}), ("schema", 2), ("builds", good["builds"] * 2)):
            with self.subTest(field=field), self.assertRaises(subject.InventoryError):
                subject.provenance_asset({**good, field: value})

    def test_real_outer_containers_copy_only_verified_inner_bytes(self):
        inner = zip_bytes([("Metis QA.app/a", b"x", REGULAR)])
        root = self.root()
        value = self.provenance(inner)
        (root / "provenance.outer.zip").write_bytes(zip_bytes([
            ("provenance.json", json.dumps(value).encode(), REGULAR), ("SHA256SUMS.txt", b"unused", REGULAR)]))
        (root / "qa.outer.zip").write_bytes(zip_bytes([("Metis-QA-1.9.7.zip", inner, REGULAR)]))
        result = subject.prepare_inner(root, self.deadline)
        self.assertEqual(result["sha256"], hashlib.sha256(inner).hexdigest())
        self.assertEqual((root / "candidate.zip").read_bytes(), inner)
        self.assertFalse((root / "Metis QA.app").exists())

    def test_outer_inner_digest_mismatch_is_rejected(self):
        root = self.root()
        value = self.provenance(b"other")
        (root / "provenance.outer.zip").write_bytes(zip_bytes([
            ("provenance.json", json.dumps(value).encode(), REGULAR), ("SHA256SUMS.txt", b"unused", REGULAR)]))
        (root / "qa.outer.zip").write_bytes(zip_bytes([("Metis-QA-1.9.7.zip", b"wrong", REGULAR)]))
        with self.assertRaisesRegex(subject.InventoryError, "INNER_DIGEST"):
            subject.prepare_inner(root, self.deadline)

    def test_full_report_rechecks_outer_hash_and_only_emits_allowlisted_binding(self):
        inner = zip_bytes([("Metis QA.app/" + MARKER, b"ordinary payload", REGULAR)])
        root = self.root()
        bodies = {"qa": zip_bytes([("Metis-QA-1.9.7.zip", inner, REGULAR)]),
                  "provenance": zip_bytes([("provenance.json", json.dumps(self.provenance(inner)).encode(), REGULAR),
                                           ("SHA256SUMS.txt", b"unused", REGULAR)])}
        binding = {"checker": subject.checker_identity(self.env()), "artifacts": {}}
        for label, body in bodies.items():
            (root / (label + ".outer.zip")).write_bytes(body)
            binding["artifacts"][label] = {"id": subject.ARTIFACTS[label][0], "size": len(body),
                                           "sha256": hashlib.sha256(body).hexdigest(), "untrusted": MARKER}
        binding["artifacts"][MARKER] = MARKER
        (root / "binding.json").write_text(json.dumps(binding))
        status, report = self.cli(root)
        self.assertEqual(status, 0)
        parsed = json.loads(report)
        self.assertEqual(parsed["checker"]["commit"], "a" * 40)
        self.assertEqual(parsed["candidateCommit"], subject.CANDIDATE_SHA)
        self.assertEqual(set(parsed["outerArtifacts"]), {"qa", "provenance"})
        self.assertEqual(set(parsed["outerArtifacts"]["qa"]), {"id", "size", "sha256"})
        self.assertEqual(parsed["innerArchive"]["sha256"], hashlib.sha256(inner).hexdigest())
        (root / "qa.outer.zip").write_bytes(bodies["qa"][:-1])
        with self.assertRaisesRegex(subject.InventoryError, "OUTER_DIGEST"):
            subject.inventory_download(root, self.env(), self.deadline)

    def test_outer_crc_failure_does_not_satisfy_inner_verification(self):
        root = self.root()
        inner = b"synthetic"
        (root / "provenance.outer.zip").write_bytes(zip_bytes([
            ("provenance.json", json.dumps(self.provenance(inner)).encode(), REGULAR),
            ("SHA256SUMS.txt", b"unused", REGULAR)]))
        raw = bytearray(zip_bytes([("Metis-QA-1.9.7.zip", inner, REGULAR)]))
        offset = raw.index(b"PK\x01\x02")
        struct.pack_into("<I", raw, offset + 16, 0)
        (root / "qa.outer.zip").write_bytes(raw)
        with self.assertRaises(zipfile.BadZipFile):
            subject.prepare_inner(root, self.deadline)

    def test_failed_download_removes_only_its_new_owned_directory(self):
        sentinel = self.base / "outside"
        sentinel.write_text(MARKER)
        run, listing = self.api_records()
        with patch.object(subject, "api_json", side_effect=[run, listing]), \
                patch.object(subject, "fetch", return_value=(1, "b" * 64)), \
                self.assertRaisesRegex(subject.InventoryError, "OUTER_DIGEST"):
            subject.download({**self.env(), "GH_TOKEN": MARKER}, self.deadline)
        self.assertEqual(list(self.base.iterdir()), [sentinel])

    def test_redirect_gets_no_token_and_error_body_is_not_consumed(self):
        class UnreadBody(Response):
            def read(self, *args):
                raise AssertionError("Redirect body consumed")
        body = UnreadBody(MARKER.encode())
        redirect = urllib.error.HTTPError("https://api.github.com/start", 302, MARKER,
                                         {"Location": "https://example.invalid/signed"}, body)
        transport = Transport([redirect, Response(b"bytes")])
        sink = io.BytesIO()
        result = subject.fetch("https://api.github.com/start", sink, 5, self.deadline, MARKER, transport)
        self.assertEqual(result, (5, hashlib.sha256(b"bytes").hexdigest()))
        self.assertEqual(transport.requests[0].get_header("Authorization"), "Bearer " + MARKER)
        self.assertIsNone(transport.requests[1].get_header("Authorization"))
        self.assertTrue(body.closed)

    def test_redirect_downgrade_userinfo_and_repeated_redirect_are_rejected(self):
        for location in ("http://example.invalid/", "https://user:password@example.invalid/"):
            error = urllib.error.HTTPError("https://api.github.com/start", 302, MARKER, {"Location": location}, Response())
            with self.subTest(location=location), self.assertRaises(subject.InventoryError):
                subject.fetch("https://api.github.com/start", io.BytesIO(), 10, self.deadline, MARKER, Transport([error]))
        replies = [urllib.error.HTTPError("https://api.github.com/start", 302, MARKER,
                                         {"Location": "https://example.invalid/repeat"}, Response()) for _ in range(4)]
        with self.assertRaises(subject.InventoryError):
            subject.fetch("https://api.github.com/start", io.BytesIO(), 10, self.deadline, MARKER, Transport(replies))

    def test_download_size_cap_and_initial_auth_host_are_enforced(self):
        with self.assertRaises(subject.InventoryError):
            subject.fetch("https://api.github.com/start", io.BytesIO(), 1, self.deadline,
                          MARKER, Transport([Response(b"too long")]))
        with self.assertRaises(subject.InventoryError):
            subject.fetch("https://example.invalid/", io.BytesIO(), 1, self.deadline, MARKER, Transport([]))

    def test_failure_boundary_never_prints_exception_or_warning_marker(self):
        for error in (ValueError(MARKER), subject.InventoryError(MARKER), UserWarning(MARKER)):
            with self.subTest(kind=type(error).__name__):
                root = self.root()
                status, report = self.cli(root, side_effect=error)
                self.assertEqual(status, 1)
                self.assertEqual(json.loads(report)["error"], "INVALID_OR_UNSUPPORTED")

    def test_actual_warning_is_promoted_before_it_can_print_private_text(self):
        def warn_during_inventory(*args):
            warnings.warn(MARKER, UserWarning)
            return {"status": "COMPLETE"}
        with warnings.catch_warnings():
            warnings.simplefilter("always")
            status, report = self.cli(self.root(), side_effect=warn_during_inventory)
        self.assertEqual(status, 1)
        self.assertEqual(json.loads(report)["error"], "INVALID_OR_UNSUPPORTED")

    def test_real_overlapping_link_warning_or_error_is_private(self):
        raw = bytearray(zip_bytes([("Metis QA.app/" + MARKER, b"target", LINK),
                                   ("Metis QA.app/other", b"target", LINK)]))
        first = raw.index(b"PK\x01\x02")
        second = raw.index(b"PK\x01\x02", first + 4)
        struct.pack_into("<I", raw, second + 42, 0)
        path = self.base / "overlap.zip"
        path.write_bytes(raw)
        root = self.root()
        status, report = self.cli(root, side_effect=lambda *args: subject.inventory(path, self.deadline))
        self.assertEqual(status, 1)
        self.assertEqual(json.loads(report)["status"], "INCOMPLETE")

    def test_cleanup_is_confined_to_owned_root_and_rejects_alias(self):
        root = self.root()
        sentinel = self.base / "outside"
        sentinel.write_text(MARKER)
        alias = self.base / "qa-zip-inventory.abcdefgh"
        alias.symlink_to(root, target_is_directory=True)
        with self.assertRaises(subject.InventoryError):
            subject.cleanup(alias, self.base)
        subject.cleanup(root, self.base)
        self.assertFalse(root.exists())
        self.assertEqual(sentinel.read_text(), MARKER)


if __name__ == "__main__":
    unittest.main()
