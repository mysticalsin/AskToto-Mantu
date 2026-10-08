"""Real, miniature archives only; run in hosted CI, never on the owner device."""

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
import warnings
import zipfile
from pathlib import Path
from unittest.mock import patch

import extract_qa_zip as subject
import inventory_qa_zip as inventory

ROOT = inventory.QA_ROOT
FILE = stat.S_IFREG | 0o644
EXECUTABLE = stat.S_IFREG | 0o755
DIRECTORY = stat.S_IFDIR | 0o755
LINK = stat.S_IFLNK | 0o755
MARKER = "PRIVATE_FIXTURE_DO_NOT_PRINT"


def archive_bytes(rows):
    output = io.BytesIO()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")  # Duplicate fixtures are deliberate, not production handling.
        with zipfile.ZipFile(output, "w") as archive:
            for row in rows:
                name, payload, mode = row[:3]
                info = zipfile.ZipInfo(name)
                info.create_system = 3
                info.external_attr = mode << 16
                info.compress_type = row[3] if len(row) > 3 else zipfile.ZIP_STORED
                info.extra = row[4] if len(row) > 4 else b""
                info.comment = MARKER.encode()
                archive.writestr(info, payload)
    return output.getvalue()


def field(raw, signature, offset, fmt, value):
    changed = bytearray(raw)
    struct.pack_into(fmt, changed, changed.index(signature) + offset, value)
    return bytes(changed)


class ExtractionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name).resolve()
        self.root = Path(tempfile.mkdtemp(prefix=inventory.ROOT_PREFIX, dir=self.base))
        (self.root / ".owner").write_bytes(inventory.OWNER_MARKER)
        self.outside = self.base / "outside"
        self.outside.write_bytes(b"outside sentinel")
        self.deadline = time.monotonic() + 60
        self.network = patch("socket.create_connection", side_effect=AssertionError("Network forbidden"))
        self.network.start()

    def tearDown(self):
        self.network.stop()
        self.temporary.cleanup()

    def save(self, rows=None, raw=None):
        (self.root / "candidate.zip").write_bytes(raw if raw is not None else archive_bytes(rows))

    def extract(self):
        return subject.extract_archive(self.root, self.base, self.deadline)

    def rejected(self, rows=None, raw=None, code=None, before_stage=False):
        self.save(rows, raw)
        before = set(self.root.iterdir())
        with patch.object(subject.tempfile, "mkdtemp", wraps=tempfile.mkdtemp) as stages:
            with self.assertRaises(Exception) as caught:
                self.extract()
        if before_stage:
            self.assertEqual(stages.call_count, 0)
        if code is not None:
            self.assertEqual(caught.exception.args, (code,))
        self.assertEqual(set(self.root.iterdir()), before)
        self.assertEqual(self.outside.read_bytes(), b"outside sentinel")

    def test_framework_parent_components_and_chained_links_preserve_bytes_and_modes(self):
        framework = ROOT + "/Contents/Frameworks/Example.framework"
        rows = [(ROOT + "/", b"", DIRECTORY),
                (ROOT + "/Contents/MacOS/Metis QA", b"not executable code", EXECUTABLE, zipfile.ZIP_DEFLATED),
                (framework + "/Versions/A/Example", b"library", FILE),
                (framework + "/Versions/Current", b"A", LINK),
                (framework + "/Example", b"Versions/Current/Example", LINK),
                (ROOT + "/Contents/Alias", b"Frameworks/Example.framework/Versions/Current/../A/Example", LINK)]
        self.save(rows)
        stage, report = self.extract()
        self.assertEqual(stage.parent, self.root)
        self.assertEqual(stat.S_IMODE(stage.stat().st_mode), 0o700)
        executable = stage / ROOT / "Contents/MacOS/Metis QA"
        self.assertEqual(executable.read_bytes(), b"not executable code")
        self.assertEqual(stat.S_IMODE(executable.stat().st_mode), 0o755)
        self.assertEqual((stage / framework / "Example").read_bytes(), b"library")
        self.assertEqual((stage / ROOT / "Contents/Alias").read_bytes(), b"library")
        self.assertEqual(os.readlink(stage / framework / "Versions/Current"), "A")
        self.assertEqual(report["files"], 2)
        self.assertEqual(report["links"], 3)
        self.assertEqual(report["actualBytes"], sum(len(row[1]) for row in rows))
        self.assertEqual(report["localHeaders"], "PASS")
        self.assertEqual(report["linkGraph"], "PASS")
        self.assertEqual(report["materialization"], "PASS")
        self.assertNotIn(MARKER, json.dumps(report))

    def test_link_expansion_occurs_before_later_parent_component(self):
        self.save([(ROOT + "/deep/directory/file", b"correct", FILE),
                   (ROOT + "/deep/file", b"wrong", FILE),
                   (ROOT + "/alias", b"deep/directory", LINK),
                   (ROOT + "/result", b"alias/../directory/file", LINK)])
        stage, _ = self.extract()
        self.assertEqual((stage / ROOT / "result").read_bytes(), b"correct")

    def test_paths_duplicates_case_and_implicit_parent_conflicts_are_refused(self):
        names = ["/" + ROOT, "../" + MARKER, ROOT + "/../x", ROOT + "/./x", ROOT + "//x",
                 ROOT + "/x//", ROOT + "/x\\y", ROOT + "/x:y",
                 ROOT + "/x\ny", ROOT + "/é", "Other.app/x", ROOT + "/" + "x" * 4096,
                 ROOT + "/" + "/".join(["x"] * 128)]
        for name in names:
            with self.subTest(name=name):
                self.rejected([(name, b"x", FILE)], before_stage=True)
        raw = archive_bytes([(ROOT + "/xay", b"x", FILE)])
        self.rejected(raw=raw.replace(b"/xay", b"/x\x00y"), code="PATH_INVALID")
        for rows in ([(ROOT + "/a", b"a", FILE), (ROOT + "/a", b"b", FILE)],
                     [(ROOT + "/a", b"a", FILE), (ROOT + "/A", b"b", FILE)],
                     [(ROOT + "/Dir/a", b"a", FILE), (ROOT + "/dir/b", b"b", FILE)]):
            with self.subTest(rows=rows):
                self.rejected(rows)

    def test_types_permissions_and_directory_encoding_are_refused_before_stage(self):
        for mode in (stat.S_IFIFO | 0o644, stat.S_IFCHR | 0o644, FILE | stat.S_ISUID,
                     stat.S_IFREG | 0o666, stat.S_IFDIR | 0o644):
            with self.subTest(mode=mode):
                self.rejected([(ROOT + ("/dir/" if stat.S_ISDIR(mode) else "/x"), b"", mode)], before_stage=True)
        for row in ((ROOT + "/dir/", b"payload", DIRECTORY),
                    (ROOT + "/dir/", b"", DIRECTORY, zipfile.ZIP_DEFLATED),
                    (ROOT + "/dir", b"", DIRECTORY),
                    (ROOT + "/file/", b"", FILE)):
            with self.subTest(row=row):
                self.rejected([row], before_stage=True)

    def test_file_and_link_ancestors_are_refused_in_either_order(self):
        for mode, value in ((FILE, b"x"), (LINK, b"target")):
            rows = [(ROOT + "/a", value, mode), (ROOT + "/a/child", b"x", FILE),
                    (ROOT + "/target", b"x", FILE)]
            for ordering in (rows, list(reversed(rows))):
                with self.subTest(mode=mode, ordering=ordering):
                    self.rejected(ordering)

    def test_invalid_link_targets_graphs_and_directory_suffixes(self):
        for target in (b"", b"/absolute", b"../../outside", b"missing", b"file/child",
                       b"file/..", b"file/", b"file\\x", b"file:x", b"\xff", b"file\n", b"file//x"):
            with self.subTest(target=target):
                self.rejected([(ROOT + "/file", b"x", FILE), (ROOT + "/link", target, LINK)])
        self.rejected([(ROOT + "/a", b"b", LINK), (ROOT + "/b", b"a", LINK)], code="LINK_CYCLE")
        self.rejected([(ROOT + "/a", b"a", LINK)], code="LINK_CYCLE")
        self.save([(ROOT + "/dir/", b"", DIRECTORY), (ROOT + "/link", b"dir/", LINK)])
        stage, _ = self.extract()
        self.assertTrue((stage / ROOT / "link").is_dir())

    def test_link_expansion_and_aggregate_operation_bounds(self):
        rows = [(ROOT + "/file", b"x", FILE)]
        rows += [(ROOT + "/l" + str(i), ("l" + str(i + 1) if i < 32 else "file").encode(), LINK)
                 for i in range(33)]
        self.rejected(rows, code="LINK_EXPANSIONS")
        with patch.object(subject, "MAX_RESOLVE_OPERATIONS", 0):
            self.rejected([(ROOT + "/file", b"x", FILE), (ROOT + "/a", b"file", LINK)],
                          code="LINK_OPERATIONS")

    def test_link_payload_and_declared_output_bounds(self):
        self.rejected([(ROOT + "/a", b"x" * (inventory.MAX_LINK + 1), LINK)], code="LINK_LIMIT")
        with patch.object(subject, "MAX_LINK_TOTAL", 1):
            self.rejected([(ROOT + "/a", b"file", LINK)], code="LINK_LIMIT")
        with patch.object(subject, "MAX_OUTPUT", 2):
            self.rejected([(ROOT + "/file", b"abc", FILE)], code="OUTPUT_LIMIT")

    def test_local_header_field_disagreements_and_versions(self):
        raw = archive_bytes([(ROOT + "/a", b"abc", FILE)])
        for offset, fmt, value in ((4, "<H", 45), (6, "<H", 8), (8, "<H", 8),
                                   (14, "<I", 1), (18, "<I", 2), (22, "<I", 2)):
            with self.subTest(offset=offset):
                self.rejected(raw=field(raw, b"PK\x03\x04", offset, fmt, value))
        altered = raw.replace((ROOT + "/a").encode(), (ROOT + "/b").encode(), 1)
        self.rejected(raw=altered, code="LOCAL_NAME")
        self.rejected(raw=raw.replace(b"PK\x03\x04", b"NOPE", 1), code="LOCAL_HEADER")

    def test_central_flags_creator_method_and_zip64_sentinels(self):
        raw = archive_bytes([(ROOT + "/a", b"abc", FILE)])
        for offset, fmt, value in ((5, "<B", 0), (6, "<H", 45), (7, "<B", 1), (8, "<H", 8),
                                   (10, "<H", 12), (20, "<I", 0xFFFFFFFF),
                                   (24, "<I", 0xFFFFFFFF), (42, "<I", 0xFFFFFFFF)):
            with self.subTest(offset=offset):
                self.rejected(raw=field(raw, b"PK\x01\x02", offset, fmt, value))

    def test_local_header_range_overlap_and_truncation(self):
        raw = archive_bytes([(ROOT + "/a", b"abc", FILE), (ROOT + "/b", b"xyz", FILE)])
        changed = bytearray(raw)
        second_central = changed.index(b"PK\x01\x02", changed.index(b"PK\x01\x02") + 1)
        struct.pack_into("<I", changed, second_central + 42, 0)
        self.rejected(raw=bytes(changed))
        overlap = bytearray(raw)
        first_central = overlap.index(b"PK\x01\x02")
        # Make the first payload contain the next local header, consistently in both directories.
        expanded = overlap.index(b"PK\x03\x04", 4) + 1 - (30 + len(ROOT + "/a"))
        for start, offsets in ((0, (18, 22)), (first_central, (20, 24))):
            for offset in offsets:
                struct.pack_into("<I", overlap, start + offset, expanded)
        self.rejected(raw=bytes(overlap), code="LOCAL_OVERLAP", before_stage=True)
        for data in (raw[:20], raw[:-15], field(raw, b"PK\x03\x04", 28, "<H", 65535)):
            with self.subTest(length=len(data)):
                self.rejected(raw=data)

    def test_timestamp_and_unix_extras_and_rejected_framing(self):
        timestamp = struct.pack("<HHBI", 0x5455, 5, 1, 100)
        unix = struct.pack("<HH", 0x7875, 5) + b"\x01\x01\x01\x01\x01"
        self.save([(ROOT + "/a", b"x", FILE, zipfile.ZIP_STORED, timestamp + unix)])
        stage, _ = self.extract()
        self.assertEqual((stage / ROOT / "a").read_bytes(), b"x")
        for extra in (timestamp + timestamp, b"\x01", struct.pack("<HH", 0x5455, 99),
                      struct.pack("<HH", 0xCAFE, 0), struct.pack("<HH", 1, 0),
                      struct.pack("<HH", 0x7875, 1) + b"\x02",
                      struct.pack("<HH", 0x5455, 1) + b"\x08"):
            with self.subTest(extra=extra):
                self.rejected([(ROOT + "/a", b"x", FILE, zipfile.ZIP_STORED, extra)])

    def test_local_only_extra_refusal(self):
        valid = struct.pack("<HHBI", 0x5455, 5, 1, 100)
        raw = archive_bytes([(ROOT + "/a", b"x", FILE, zipfile.ZIP_STORED, valid)])
        changed = bytearray(raw)
        struct.pack_into("<H", changed, 30 + len(ROOT + "/a"), 1)
        self.rejected(raw=bytes(changed), code="EXTRA_UNSUPPORTED")

    def test_crc_failure_removes_owned_stage_and_does_not_follow_outside_link(self):
        raw = bytearray(archive_bytes([(ROOT + "/a", b"abcdef", FILE)]))
        raw[30 + len(ROOT + "/a")] ^= 1
        self.rejected(raw=bytes(raw))
        self.rejected([(ROOT + "/outside", b"../../outside", LINK)], code="LINK_ESCAPE")

    def test_archive_cap_and_expired_deadline_make_no_stage(self):
        with patch.object(subject, "MAX_ARCHIVE", 1):
            self.rejected([(ROOT + "/a", b"x", FILE)], code="ARCHIVE_LIMIT")
        self.deadline = time.monotonic() - 1
        self.rejected([(ROOT + "/a", b"x", FILE)], code="DEADLINE")

    def test_preflight_never_opens_ordinary_payload_and_checks_entry_limit(self):
        self.save([(ROOT + "/a", b"payload", FILE)])
        with inventory.archive(self.root / "candidate.zip") as archive:
            with patch.object(zipfile.ZipFile, "open", side_effect=AssertionError("Ordinary payload read")):
                result = subject.preflight(archive, self.deadline, {})
        self.assertEqual(len(result[0]), 1)
        self.assertFalse(list(self.root.glob(subject.STAGE_PREFIX + "*")))
        with patch.object(inventory, "MAX_ENTRIES", 0):
            self.rejected([(ROOT + "/a", b"payload", FILE)], code="ENTRY_LIMIT", before_stage=True)

    def test_streamed_actual_output_cap_and_size_are_enforced_before_overrun_write(self):
        for expected, cap, data in ((2, 10, b"abc"), (3, 2, b"abc"), (4, 10, b"abc")):
            with self.subTest(expected=expected, cap=cap):
                output = io.BytesIO()
                with patch.object(subject, "MAX_OUTPUT", cap), self.assertRaises(inventory.InventoryError):
                    subject.copy_file(io.BytesIO(data), output, expected, {"actualBytes": 0}, self.deadline)
                self.assertLessEqual(len(output.getvalue()), min(expected, cap))

    def test_no_tree_reuse_and_regular_files_precede_all_links(self):
        self.save([(ROOT + "/file", b"content", FILE), (ROOT + "/link", b"file", LINK)])
        real_link = os.symlink
        observed = []
        def link(target, name, **kwargs):
            stage = next(self.root.glob(subject.STAGE_PREFIX + "*"))
            observed.append((stage / ROOT / "file").read_bytes())
            return real_link(target, name, **kwargs)
        with patch.object(subject.os, "symlink", side_effect=link):
            first, _ = self.extract()
        second, _ = self.extract()
        self.assertNotEqual(first, second)
        self.assertEqual(observed, [b"content"])
        self.assertEqual((first / ROOT / "file").read_bytes(), b"content")

    def test_cleanup_failure_is_not_suppressed(self):
        raw = bytearray(archive_bytes([(ROOT + "/a", b"abc", FILE)]))
        raw[30 + len(ROOT + "/a")] ^= 1
        self.save(raw=bytes(raw))
        with patch.object(subject.shutil, "rmtree", side_effect=OSError(MARKER)):
            with self.assertRaises(inventory.InventoryError) as caught:
                self.extract()
        self.assertEqual(caught.exception.args, ("CLEANUP_FAILED",))
        self.assertEqual(self.outside.read_bytes(), b"outside sentinel")

    def test_cleanup_does_not_follow_a_tampered_owned_symlink(self):
        outside_dir = self.base / "outside-directory"
        outside_dir.mkdir()
        sentinel = outside_dir / "sentinel"
        sentinel.write_bytes(b"unchanged")
        real_link = os.symlink
        def redirected(target, name, **kwargs):
            return real_link(str(outside_dir), name, **kwargs)
        with patch.object(subject.os, "symlink", side_effect=redirected):
            self.rejected([(ROOT + "/file", b"content", FILE), (ROOT + "/link", b"file", LINK)],
                          code="TREE_INVALID")
        self.assertEqual(sentinel.read_bytes(), b"unchanged")

    def test_directory_descriptor_refuses_real_symlink_parent(self):
        stage = self.root / "synthetic-stage"
        stage.mkdir(mode=0o700)
        (stage / "redirect").symlink_to(self.base, target_is_directory=True)
        with self.assertRaises(OSError):
            with subject.directory_fd(stage, ["redirect"]):
                self.fail("Symlink parent accepted")
        self.assertEqual(self.outside.read_bytes(), b"outside sentinel")

    def env(self):
        return {"RUNNER_TEMP": str(self.base), "GITHUB_ACTIONS": "true",
                "RUNNER_ENVIRONMENT": "github-hosted", "GITHUB_REPOSITORY": inventory.REPOSITORY,
                "GITHUB_SHA": "a" * 40, "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1"}

    def download_fixture(self, rows):
        inner = archive_bytes(rows)
        asset = {"name": "Metis-QA-1.9.7.zip", "size": len(inner), "sha256": hashlib.sha256(inner).hexdigest()}
        provenance = {"schema": 1, "repository": inventory.REPOSITORY, "commit": inventory.CANDIDATE_SHA,
                      "run": {"id": inventory.CANDIDATE_RUN}, "version": "1.9.7", "builds": [
                          {"variant": inventory.VARIANT, "artifact": "candidate-mac-qa-identity", "assets": [asset]}]}
        outer = {"qa": archive_bytes([(asset["name"], inner, FILE)]),
                 "provenance": archive_bytes([("provenance.json", json.dumps(provenance).encode(), FILE),
                                               ("SHA256SUMS.txt", b"synthetic", FILE)])}
        bindings = {}
        for label, data in outer.items():
            (self.root / (label + ".outer.zip")).write_bytes(data)
            bindings[label] = {"id": inventory.ARTIFACTS[label][0], "size": len(data),
                               "sha256": hashlib.sha256(data).hexdigest()}
        (self.root / "binding.json").write_text(json.dumps({"checker": inventory.checker_identity(self.env()),
                                                           "artifacts": bindings}))

    def cli(self, side_effect=None):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.ExitStack() as stack:
            stack.enter_context(contextlib.redirect_stdout(out))
            stack.enter_context(contextlib.redirect_stderr(err))
            stack.enter_context(patch.object(subject.resource, "setrlimit"))
            stack.enter_context(patch.object(subject.signal, "alarm"))
            if side_effect is not None:
                stack.enter_context(patch.object(subject, "extract_archive", side_effect=side_effect))
            code = subject.cli([str(self.root)], self.env())
        raw = (self.root / "inventory.json").read_text()
        self.assertNotIn(MARKER, out.getvalue() + err.getvalue() + raw)
        return code, json.loads(raw)

    def test_combined_cli_revalidates_binding_once_and_scopes_unknown_metadata(self):
        self.download_fixture([(ROOT + "/a", b"payload", FILE)])
        with patch.object(subject, "inventory_download", wraps=inventory.inventory_download) as call:
            code, report = self.cli()
        self.assertEqual(code, 0)
        self.assertEqual(call.call_count, 1)
        self.assertEqual(report["status"], "PASS")
        self.assertEqual(report["metadataInventory"]["localHeaders"], "NOT_INSPECTED")
        self.assertEqual(report["extraction"]["localHeaders"], "PASS")
        self.assertEqual(report["extraction"]["actualBytes"], 7)
        self.assertEqual(report["appIdentity"], "NOT_ASSESSED")
        self.assertEqual(report["appLaunch"], "NOT_RUN")
        self.assertEqual((self.root / "candidate.zip").stat().st_size,
                         report["metadataInventory"]["innerArchive"]["size"])

    def test_combined_cli_does_not_reuse_an_existing_inner(self):
        self.download_fixture([(ROOT + "/a", b"payload", FILE)])
        (self.root / "candidate.zip").write_bytes(b"existing sentinel")
        code, report = self.cli()
        self.assertEqual(code, 1)
        self.assertEqual(report["status"], "FAIL")
        self.assertEqual((self.root / "candidate.zip").read_bytes(), b"existing sentinel")
        self.assertFalse(list(self.root.glob(subject.STAGE_PREFIX + "*")))

    def test_report_collision_preserves_existing_report_and_removes_new_stage(self):
        self.download_fixture([(ROOT + "/a", b"payload", FILE)])
        (self.root / "inventory.json").write_text('{"existing":true}')
        code, report = self.cli()
        self.assertEqual(code, 1)
        self.assertEqual(report, {"existing": True})
        self.assertFalse(list(self.root.glob(subject.STAGE_PREFIX + "*")))

    def test_cli_masks_actual_warning_and_exception_payloads_and_reports_cleanup_failure(self):
        def warning(*args, **kwargs):
            warnings.warn(MARKER, UserWarning)
        for effect, expected in ((warning, "INVALID_OR_UNSUPPORTED"),
                                 (OSError(MARKER), "INVALID_OR_UNSUPPORTED"),
                                 (inventory.InventoryError("CLEANUP_FAILED"), "CLEANUP_FAILED")):
            with self.subTest(expected=expected):
                self.download_fixture([(ROOT + "/a", b"payload", FILE)])
                code, report = self.cli(effect)
                self.assertEqual(code, 1)
                self.assertEqual(report["error"], expected)
                self.assertEqual(report["appLaunch"], "NOT_RUN")
                (self.root / "candidate.zip").unlink()
                (self.root / "inventory.json").unlink()


if __name__ == "__main__":
    unittest.main()
