"""Real synthetic plist/ASAR bytes and owned files; no app or network execution."""

import contextlib
import hashlib
import io
import json
import os
import plistlib
import stat
import struct
import tempfile
import time
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import qa_bundle_identity as subject
import extract_qa_zip as extraction
import inventory_qa_zip as inventory
from inventory_qa_zip import InventoryError

MARKER = "PRIVATE_IDENTITY_FIXTURE"
EXPECTED = {"CFBundleIdentifier": "com.mantu.asktoto.qa", "CFBundleExecutable": "Metis QA"}


def asar_bytes(package=b'{"name":"asktoto-qa"}', entry=None, header=None):
    if header is None:
        header = json.dumps({"files": {"package.json": entry if entry is not None else {
            "size": len(package), "offset": "0"}}}, separators=(",", ":")).encode()
    padding = b"\x00" * (-len(header) % 4)
    size = 8 + len(header) + len(padding)
    return struct.pack("<IIII", 4, size, size - 4, len(header)) + header + padding + package


def bundle_rows(plist=None, package=b'{"name":"asktoto-qa"}'):
    """Same real identity bytes for standalone and combined extraction checks."""
    prefix = "Metis QA.app/Contents/"
    return [(prefix + "Info.plist", plist if plist is not None else plistlib.dumps(EXPECTED), stat.S_IFREG | 0o644),
            (prefix + "MacOS/Metis QA", b"synthetic non-executable content", stat.S_IFREG | 0o755),
            (prefix + "Resources/app.asar", asar_bytes(package), stat.S_IFREG | 0o644)]


class IdentityTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name).resolve()
        self.deadline = time.monotonic() + 60
        self.network = patch("socket.create_connection", side_effect=AssertionError("Network forbidden"))
        self.network.start()

    def tearDown(self):
        self.network.stop()
        self.temporary.cleanup()

    def fixture(self, plist=None, asar=None):
        stage = Path(tempfile.mkdtemp(prefix="stage.", dir=self.base))
        for name, payload, mode in bundle_rows(plist):
            path = stage / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(payload)
            path.chmod(stat.S_IMODE(mode))
        if asar is not None:
            (stage / "Metis QA.app/Contents/Resources/app.asar").write_bytes(asar)
        return stage

    def reject(self, stage, code=None):
        with self.assertRaises(InventoryError) as caught:
            subject.verify_qa_identity(stage, self.deadline)
        if code is not None:
            self.assertEqual(caught.exception.args, (code,))
        self.assertNotIn(MARKER, str(caught.exception))

    def test_real_xml_and_binary_plists_with_unrelated_metadata(self):
        for fmt in (plistlib.FMT_XML, plistlib.FMT_BINARY):
            with self.subTest(fmt=fmt):
                stage = self.fixture(plistlib.dumps({**EXPECTED, "Other": {"Name": MARKER}}, fmt=fmt))
                framework = stage / "Metis QA.app/Contents/Frameworks/Example.framework"
                (framework / "Versions/A").mkdir(parents=True)
                (framework / "Versions/Current").symlink_to("A")
                report = subject.verify_qa_identity(stage, self.deadline)
                self.assertEqual(report, {"status": "PASS", "bundleIdentifier": "com.mantu.asktoto.qa",
                                          "bundleExecutable": "Metis QA", "packageName": "asktoto-qa",
                                          "appleParserAgreement": "NOT_RUN", "codeSignature": "NOT_ASSESSED"})
                self.assertNotIn(MARKER, json.dumps(report))

    def test_plist_shipping_missing_wrong_type_and_executable_mismatch(self):
        values = [{**EXPECTED, "CFBundleIdentifier": "com.mantu.asktoto"},
                  {**EXPECTED, "CFBundleIdentifier": ["com.mantu.asktoto.qa"]},
                  {**EXPECTED, "CFBundleExecutable": "Other"},
                  {**EXPECTED, "CFBundleExecutable": True}, {"CFBundleIdentifier": "com.mantu.asktoto.qa"}, []]
        for value in values:
            with self.subTest(value=value):
                self.reject(self.fixture(plistlib.dumps(value)), "IDENTITY_PLIST_FIELDS")

    def test_duplicate_xml_and_binary_keys_are_rejected_by_actual_parsers(self):
        xml = plistlib.dumps(EXPECTED).replace(b"</dict>", b"<key>CFBundleIdentifier</key><string>"
                                             + MARKER.encode() + b"</string></dict>", 1)
        binary = plistlib.dumps(EXPECTED, fmt=plistlib.FMT_BINARY)
        self.assertEqual(len(b"CFBundleIdentifier"), len(b"CFBundleExecutable"))
        binary = binary.replace(b"CFBundleExecutable", b"CFBundleIdentifier")
        # Both are otherwise parseable, not generic malformed-input negatives.
        self.assertIsInstance(plistlib.loads(xml), dict)
        self.assertIsInstance(plistlib.loads(binary), dict)
        for raw in (xml, binary):
            self.reject(self.fixture(raw), "IDENTITY_PLIST_DUPLICATE")

    def test_corrupt_xml_binary_entities_and_oversize_are_fixed_failures(self):
        entity = (b'<?xml version="1.0"?><!DOCTYPE plist [<!ENTITY x SYSTEM "https://invalid.example/'
                  + MARKER.encode() + b'">]><plist><dict><key>CFBundleIdentifier</key><string>&x;</string></dict></plist>')
        for raw in (b"<plist><dict>" + MARKER.encode(), b"bplist00" + MARKER.encode(), entity):
            self.reject(self.fixture(raw), "IDENTITY_PLIST_INVALID")
        stage = self.fixture(b"x" * (subject.MAX_PLIST + 1))
        with patch.object(subject.os, "pread", wraps=os.pread) as reads:
            self.reject(stage, "IDENTITY_PLIST_SIZE")
        self.assertEqual(reads.call_count, 0)

    def test_unknown_xml_elements_do_not_claim_apple_parser_agreement(self):
        raw = plistlib.dumps(EXPECTED).replace(b"</dict>", b"<unknown>" + MARKER.encode() + b"</unknown></dict>")
        report = subject.verify_qa_identity(self.fixture(raw), self.deadline)
        self.assertEqual(report["appleParserAgreement"], "NOT_RUN")

    def test_root_intermediate_and_critical_leaf_symlinks_are_refused(self):
        paths = ("Metis QA.app", "Metis QA.app/Contents", "Metis QA.app/Contents/MacOS",
                 "Metis QA.app/Contents/Resources", "Metis QA.app/Contents/Info.plist",
                 "Metis QA.app/Contents/MacOS/Metis QA", "Metis QA.app/Contents/Resources/app.asar")
        stage = self.fixture()
        alias = self.base / "stage-alias"
        alias.symlink_to(stage, target_is_directory=True)
        self.reject(alias, "IDENTITY_FILE")
        for name in paths:
            with self.subTest(name=name):
                stage = self.fixture()
                path = stage / name
                target = path.with_name(path.name + ".real")
                path.rename(target)
                path.symlink_to(target.name, target_is_directory=target.is_dir())
                self.reject(stage, "IDENTITY_FILE")
                self.assertTrue(target.exists())

    def test_critical_hardlinks_and_special_files_are_refused_before_open(self):
        for name in ("Info.plist", "MacOS/Metis QA", "Resources/app.asar"):
            stage = self.fixture()
            path = stage / "Metis QA.app/Contents" / name
            os.link(path, stage / "alias")
            self.reject(stage, "IDENTITY_FILE")
        for kind in ("fifo", "directory", "missing"):
            with self.subTest(kind=kind):
                stage = self.fixture()
                path = stage / "Metis QA.app/Contents/Info.plist"
                path.unlink()
                if kind == "fifo":
                    os.mkfifo(path)
                elif kind == "directory":
                    path.mkdir()
                with patch.object(subject.os, "open", wraps=os.open) as opens:
                    self.reject(stage, "IDENTITY_FILE")
                self.assertFalse(any(call.args[0] == "Info.plist" for call in opens.call_args_list))

    def test_executable_must_be_nonempty_and_exactly_0755(self):
        for mode, payload in ((0o644, b"data"), (0o777, b"data"), (0o4755, b"data"), (0o755, b"")):
            with self.subTest(mode=mode, payload=payload):
                stage = self.fixture()
                executable = stage / "Metis QA.app/Contents/MacOS/Metis QA"
                executable.write_bytes(payload)
                executable.chmod(mode)
                self.reject(stage, "IDENTITY_EXECUTABLE")

    def test_ownership_mismatch_and_expired_deadline(self):
        stage = self.fixture()
        with patch.object(subject.os, "getuid", return_value=os.getuid() + 1):
            self.reject(stage, "IDENTITY_FILE")
        self.deadline = time.monotonic() - 1
        self.reject(stage, "DEADLINE")

    def test_asar_prefix_length_json_and_range_failures(self):
        raw = asar_bytes()
        changes = ((0, 3), (4, 7), (4, subject.MAX_HEADER + 1), (8, 0), (12, subject.MAX_HEADER))
        for offset, value in changes:
            with self.subTest(offset=offset, value=value):
                changed = bytearray(raw)
                struct.pack_into("<I", changed, offset, value)
                self.reject(self.fixture(asar=bytes(changed)))
        for invalid in (raw[:10], raw[:-1], asar_bytes(header=b"{" + MARKER.encode()),
                        asar_bytes(header=b'{"files":[]}'), asar_bytes(header=b"[]")):
            self.reject(self.fixture(asar=invalid))

    def test_packed_root_package_only_and_strict_size_offset_fields(self):
        valid = {"size": len(b'{"name":"asktoto-qa"}'), "offset": "0"}
        changes = [{"link": "other"}, {"link": None}, {"unpacked": True}, {"unpacked": False}, {"files": {}},
                   {"size": True}, {"size": 0}, {"size": -1}, {"size": 1.5}, {"size": subject.MAX_PACKAGE + 1},
                   {"offset": 0}, {"offset": "-1"}, {"offset": "01"}, {"offset": "1e0"}, {"offset": "0.0"},
                   {"offset": str(subject.MAX_SAFE + 1)}, {"offset": "100"}]
        for change in changes:
            with self.subTest(change=change):
                self.reject(self.fixture(asar=asar_bytes(entry={**valid, **change})))
        self.reject(self.fixture(asar=asar_bytes(header=b'{"files":{"nested":{"files":{"package.json":{}}}}}')))
        numeric_size = asar_bytes(entry={**valid, "size": float(valid["size"])})
        self.assertEqual(subject.verify_qa_identity(self.fixture(asar=numeric_size), self.deadline)["status"], "PASS")

    def test_json_last_key_semantics_reject_effective_shipping_identity(self):
        for package in (b'{"name":"asktoto-qa","name":"asktoto"}', b'{"name":false}', b"[]"):
            self.reject(self.fixture(asar=asar_bytes(package)), "IDENTITY_PACKAGE_NAME")
        raw = asar_bytes(b'{"name":"asktoto","name":"asktoto-qa"}')
        self.assertEqual(subject.verify_qa_identity(self.fixture(asar=raw), self.deadline)["status"], "PASS")
        package = b'{"name":"asktoto-qa"}'
        valid = json.dumps({"size": len(package), "offset": "0"}).encode()
        header = b'{"files":{"package.json":' + valid + b',"package.json":{"size":true,"offset":"0"}}}'
        self.reject(self.fixture(asar=asar_bytes(package, header=header)), "IDENTITY_ASAR_ENTRY")

    def test_invalid_utf8_and_nonstandard_json_numbers_are_not_silently_accepted(self):
        for raw in (b'{"name":"asktoto-qa","other":NaN}', b'{"name":"asktoto-qa","other":Infinity}',
                    b'{"name":"asktoto-qa","other":-Infinity}', b'{"name":"asktoto-qa","other":"\xff"}'):
            self.reject(self.fixture(asar=asar_bytes(raw)), "IDENTITY_ASAR_JSON")
        for header in (b'{"files":{},"other":NaN}', b'{"files":{},"other":"\xff"}'):
            self.reject(self.fixture(asar=asar_bytes(header=header)), "IDENTITY_ASAR_JSON")

    def test_asar_only_reads_prefix_bounded_header_and_root_package(self):
        stage = self.fixture()
        path = stage / "Metis QA.app/Contents/Resources/app.asar"
        original_size = path.stat().st_size
        with path.open("ab") as stream:
            stream.write(b"ignored opaque file data" * 1000)
        real_read = os.pread
        reads = []
        def read(fd, size, offset):
            if os.fstat(fd).st_size == path.stat().st_size:
                reads.append((offset, size))
            return real_read(fd, size, offset)
        with patch.object(subject.os, "pread", side_effect=read):
            report = subject.verify_qa_identity(stage, self.deadline)
        self.assertEqual(report["status"], "PASS")
        self.assertEqual(reads[0], (0, 16))
        self.assertTrue(all(offset + size <= original_size for offset, size in reads))

    def test_combined_cli_checks_live_stage_and_cleans_identity_failure(self):
        root = Path(tempfile.mkdtemp(prefix=inventory.ROOT_PREFIX, dir=self.base))
        (root / ".owner").write_bytes(inventory.OWNER_MARKER)
        env = {"RUNNER_TEMP": str(self.base), "GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted",
               "GITHUB_REPOSITORY": inventory.REPOSITORY, "GITHUB_SHA": "a" * 40,
               "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1"}
        def zipped(rows):
            output = io.BytesIO()
            with zipfile.ZipFile(output, "w") as archive:
                for name, payload, mode in rows:
                    info = zipfile.ZipInfo(name)
                    info.create_system = 3
                    info.external_attr = mode << 16
                    archive.writestr(info, payload)
            return output.getvalue()
        inner = zipped(bundle_rows(package=json.dumps({"name": MARKER}).encode()))
        asset = {"name": "Metis-QA-1.9.7.zip", "size": len(inner), "sha256": hashlib.sha256(inner).hexdigest()}
        provenance = {"schema": 1, "repository": inventory.REPOSITORY, "commit": inventory.CANDIDATE_SHA,
                      "run": {"id": inventory.CANDIDATE_RUN}, "version": "1.9.7", "builds": [
                          {"variant": inventory.VARIANT, "artifact": "candidate-mac-qa-identity", "assets": [asset]}]}
        regular = stat.S_IFREG | 0o644
        outer = {"qa": zipped([(asset["name"], inner, regular)]), "provenance": zipped([
            ("provenance.json", json.dumps(provenance).encode(), regular), ("SHA256SUMS.txt", b"fixture", regular)])}
        bindings = {}
        for label, raw in outer.items():
            (root / (label + ".outer.zip")).write_bytes(raw)
            bindings[label] = {"id": inventory.ARTIFACTS[label][0], "size": len(raw),
                               "sha256": hashlib.sha256(raw).hexdigest()}
        (root / "binding.json").write_text(json.dumps({"checker": inventory.checker_identity(env),
                                                      "artifacts": bindings}))
        extracted = []
        real_extract = extraction.extract_archive
        def extract(*args, **kwargs):
            result = real_extract(*args, **kwargs)
            extracted.append(result[0])
            return result
        out, err = io.StringIO(), io.StringIO()
        with contextlib.ExitStack() as stack:
            stack.enter_context(contextlib.redirect_stdout(out))
            stack.enter_context(contextlib.redirect_stderr(err))
            stack.enter_context(patch.object(extraction.resource, "setrlimit"))
            stack.enter_context(patch.object(extraction.signal, "signal"))
            stack.enter_context(patch.object(extraction.signal, "alarm"))
            stack.enter_context(patch.object(extraction, "extract_archive", side_effect=extract))
            checked = stack.enter_context(patch.object(extraction, "verify_qa_identity",
                                                       wraps=subject.verify_qa_identity))
            code = extraction.cli([str(root)], env)
        report = json.loads((root / "inventory.json").read_bytes())
        self.assertEqual(code, 1)
        self.assertEqual(len(extracted), 1)
        self.assertEqual(checked.call_count, 1)
        self.assertIs(checked.call_args.args[0], extracted[0])
        self.assertEqual(extracted[0].parent, root)
        self.assertFalse(extracted[0].exists())
        self.assertFalse(list(root.glob(extraction.STAGE_PREFIX + "*")))
        self.assertEqual(report["status"], "FAIL")
        self.assertEqual(report["error"], "IDENTITY_PACKAGE_NAME")
        self.assertEqual(report["extraction"]["materialization"], "PASS")
        self.assertEqual(report["appIdentity"], {"status": "FAIL"})
        self.assertEqual(report["appLaunch"], "NOT_RUN")
        self.assertNotIn(MARKER, out.getvalue() + err.getvalue() + json.dumps(report))


if __name__ == "__main__":
    unittest.main()
