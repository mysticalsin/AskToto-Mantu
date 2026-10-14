#!/usr/bin/env python3
"""Build and verify the reviewed global-agent 4.1.3 source derivative in CI only."""

from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import sys
import tarfile
import zlib

ROOT = Path(__file__).resolve().parents[2]
VENDOR = ROOT / "vendor" / "global-agent"
MANIFEST_PATH = VENDOR / "manifest.json"
FIXTURES_PATH = VENDOR / "negative-fixtures.json"
SOURCE_PATH = VENDOR / "4.1.3-upstream.tgz"
DERIVATIVE_PATH = VENDOR / "4.1.3-metis-ip-host.tgz"
MAX_ARCHIVE_BYTES = 128 * 1024
# Bound decompression before tarfile parses member headers.  In particular,
# TarFile.next() may consume an entire PAX/GNU extension body before yielding
# the following entry, so a member-count check alone is not a resource bound.
MAX_RAW_TAR_BYTES = 256 * 1024
MAX_MEMBERS = 64
MAX_MEMBER_BYTES = 100_000
MAX_TOTAL_BYTES = 128 * 1024
PATCH_LINE = b"                host: configuration.host,\n"
EXPECTED_PACKAGE = {
    "name": "global-agent",
    "version": "4.1.3",
    "license": "BSD-3-Clause",
    "sourceTarball": "https://registry.npmjs.org/global-agent/-/global-agent-4.1.3.tgz",
    "sourceTarballSha256": "478ca4fff13292091adabb7f8ef985bf952f809cbf53ee5f9828ebd49b47a0a8",
    "sourceIntegrity": "sha512-KUJEViiuFT3I97t+GYMikLPJS2Lfo/S2F+DQuBWzuzaMPnvt5yyZePzArx36fBzpGTxZjIpDbXLeySLgh+k76g==",
    "npmShasum": "318a8a132fcf76c74adb27de2e1466d7e9241125",
    "metadataSignatureKeyId": "SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U",
    "metadataSignature": "MEUCIAssZwQYrLOuHxlCfoeGrlbpGqEEa9rSpIYzijjzpjTrAiEA04IRImRoNLW7NPwjCEIDOq3YhdTcIj/WKtGtpsqBO/g=",
    "fileCount": 47,
    "unpackedSize": 87313,
    "licensePath": "package/LICENSE",
    "licenseSha256": "2aabdab5d0ce03a7314def8222988c2da4ba593ae82ae312439e5e306001dbae",
}
EXPECTED_PATCH = {
    "path": "package/dist/classes/HttpsProxyAgent.js",
    "sha256": "02ce4e40facf58980e2cdfd698d4be31af8008b40f109220542821a821394734",
    "preimageSha256": "81d726b90298b0025023a4a2f254a14d5ab6ac8ba45cb80396231f30712e1f47",
    "preimageBytes": 2442,
    "postimageSha256": "2548c955fc8fc40615a6722af6627b6d563a1dd586791d4f486feb9b4bfafaa0",
    "postimageBytes": 2484,
    "change": "add host: configuration.host to tls.connect options while preserving the existing TLS configuration and CONNECT socket",
}
EXPECTED_PATCH_FILE = (
    b"--- a/package/dist/classes/HttpsProxyAgent.js\n"
    b"+++ b/package/dist/classes/HttpsProxyAgent.js\n"
    b"@@ -28,6 +28,7 @@\n"
    b"             const secureSocket = tls_1.default.connect({\n"
    b"                 ...configuration.tls,\n"
    b"+                host: configuration.host,\n"
    b"                 socket,\n"
    b"             });\n"
)
EXPECTED_FIXTURES = {
    "missing-official-archive": "official source tarball SHA-256 mismatch",
    "tampered-official-archive": "official source tarball SHA-256 mismatch",
    "wrong-manifest-postimage": "manifest provenance differs",
    "altered-patch-file": "plain patch file identity mismatch",
    "extra-member": "derivative member set differs from official source",
    "duplicate-member": "duplicate member pathname",
    "traversal-member": "unsafe member pathname",
    "symlink-member": "non-regular or oversized member",
    "modified-extra-member": "derivative must change exactly the approved module",
    "wrong-patch-postimage": "derivative contains an unknown preimage or extra modification",
    "oversized-compressed-archive": "archive exceeds byte limit",
    "excessive-raw-expansion": "archive expands beyond raw tar byte limit",
    "excessive-member-count": "unexpected member count",
}
EXPECTED_POSITIVE_FIXTURES = {"known-positive-derivative": "known positive derivative accepted"}


class Refusal(Exception):
    pass


def fail(message: str) -> None:
    raise Refusal(message)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def validate_manifest(value: dict, patch_file_override: bytes | None = None) -> dict:
    if value.get("schemaVersion") != 1:
        fail("unknown manifest schema")
    if value.get("package") != EXPECTED_PACKAGE or value.get("patch") != EXPECTED_PATCH:
        fail("manifest provenance differs from the pinned official source and patch")
    if patch_file_override is None:
        try:
            patch_file = (VENDOR / "ip-target-host.patch").read_bytes()
        except OSError as error:
            fail(f"patch file unavailable: {error.__class__.__name__}")
    else:
        patch_file = patch_file_override
    if patch_file != EXPECTED_PATCH_FILE or sha256(patch_file) != EXPECTED_PATCH["sha256"]:
        fail("plain patch file identity mismatch")
    return value


def load_manifest() -> dict:
    try:
        value = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        fail(f"manifest unreadable: {error.__class__.__name__}")
    return validate_manifest(value)


def safe_name(name: str) -> None:
    if not name or "\\" in name or "\x00" in name:
        fail("invalid member pathname")
    path = PurePosixPath(name)
    if path.is_absolute() or any(part in ("", ".", "..") for part in name.split("/")):
        fail("unsafe member pathname")
    if path.as_posix() != name:
        fail("noncanonical member pathname")


def read_archive(data: bytes, expected_count: int | None = None) -> dict[str, tuple[bytes, tarfile.TarInfo]]:
    if len(data) > MAX_ARCHIVE_BYTES:
        fail("archive exceeds byte limit")
    try:
        decompressor = zlib.decompressobj(16 + zlib.MAX_WBITS)
        raw_tar = decompressor.decompress(data, MAX_RAW_TAR_BYTES + 1)
        if len(raw_tar) > MAX_RAW_TAR_BYTES:
            fail("archive expands beyond raw tar byte limit")
        if not decompressor.eof or decompressor.unused_data or decompressor.unconsumed_tail:
            fail("invalid or trailing gzip data")
    except zlib.error as error:
        fail(f"invalid gzip tar archive: {error.__class__.__name__}")
    members: dict[str, tuple[bytes, tarfile.TarInfo]] = {}
    total = 0
    try:
        archive = tarfile.open(fileobj=io.BytesIO(raw_tar), mode="r:")
        with archive:
            entry_count = 0
            while True:
                entry = archive.next()
                if entry is None:
                    break
                entry_count += 1
                # Check before retaining or extracting the 65th member.  Any
                # extension payload parsed by next() is already covered by the
                # raw-tar byte cap above.
                if entry_count > MAX_MEMBERS:
                    fail("unexpected member count")
                safe_name(entry.name)
                if entry.name in members:
                    fail("duplicate member pathname")
                if not entry.isfile() or entry.size < 0 or entry.size > MAX_MEMBER_BYTES:
                    fail("non-regular or oversized member")
                total += entry.size
                if total > MAX_TOTAL_BYTES:
                    fail("unpacked archive exceeds byte limit")
                stream = archive.extractfile(entry)
                if stream is None:
                    fail("member content unavailable")
                content = stream.read(MAX_MEMBER_BYTES + 1)
                if len(content) != entry.size:
                    fail("member size mismatch")
                members[entry.name] = (content, entry)
            if expected_count is not None and entry_count != expected_count:
                fail("unexpected member count")
    except (tarfile.TarError, OSError, EOFError) as error:
        fail(f"invalid gzip tar archive: {error.__class__.__name__}")
    return members


def validate_source(data: bytes, manifest: dict) -> dict[str, tuple[bytes, tarfile.TarInfo]]:
    package = manifest["package"]
    if sha256(data) != package["sourceTarballSha256"]:
        fail("official source tarball SHA-256 mismatch")
    expected_integrity = package["sourceIntegrity"]
    actual_integrity = "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode("ascii")
    if actual_integrity != expected_integrity:
        fail("official source tarball integrity mismatch")
    members = read_archive(data, package["fileCount"])
    if sum(info.size for _, info in members.values()) != package["unpackedSize"]:
        fail("official source unpacked size mismatch")
    if "package/LICENSE" not in members or sha256(members["package/LICENSE"][0]) != package["licenseSha256"]:
        fail("official license content mismatch")
    try:
        vendored_license = (VENDOR / "LICENSE").read_bytes()
    except OSError as error:
        fail(f"vendored license unavailable: {error.__class__.__name__}")
    if vendored_license != members["package/LICENSE"][0]:
        fail("vendored license differs from the official package notice")
    patch = manifest["patch"]
    target = members.get(patch["path"])
    if target is None:
        fail("patch target missing from official source")
    content = target[0]
    if len(content) != patch["preimageBytes"] or sha256(content) != patch["preimageSha256"]:
        fail("unknown patch preimage")
    return members


def patched_members(source: dict[str, tuple[bytes, tarfile.TarInfo]], manifest: dict) -> dict[str, tuple[bytes, tarfile.TarInfo]]:
    result = dict(source)
    patch = manifest["patch"]
    name = patch["path"]
    original, info = result[name]
    old = b"                socket,\n"
    if original.count(old) != 1:
        fail("patch anchor occurrence count is not one")
    modified = original.replace(old, PATCH_LINE + old, 1)
    if len(modified) != patch["postimageBytes"] or sha256(modified) != patch["postimageSha256"]:
        fail("patch postimage mismatch")
    result[name] = (modified, info)
    return result


def validate_derivative(data: bytes, source: dict[str, tuple[bytes, tarfile.TarInfo]], manifest: dict) -> dict[str, tuple[bytes, tarfile.TarInfo]]:
    derivative = read_archive(data)
    if derivative.keys() != source.keys():
        fail("derivative member set differs from official source")
    expected = patched_members(source, manifest)
    changed = [name for name in source if derivative[name][0] != source[name][0]]
    if changed != [manifest["patch"]["path"]]:
        fail("derivative must change exactly the approved module")
    for name, (content, _) in derivative.items():
        if content != expected[name][0]:
            fail("derivative contains an unknown preimage or extra modification")
    patch_path = manifest["patch"]["path"]
    if len(derivative[patch_path][0]) - len(source[patch_path][0]) != 42:
        fail("approved module delta is not exactly 42 bytes")
    if data != deterministic_tar(expected):
        fail("derivative archive metadata or encoding is noncanonical")
    return derivative


def deterministic_tar(members: dict[str, tuple[bytes, tarfile.TarInfo]]) -> bytes:
    output = io.BytesIO()
    with gzip.GzipFile(fileobj=output, mode="wb", filename="", mtime=0, compresslevel=9) as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=tarfile.USTAR_FORMAT) as archive:
            for name in sorted(members):
                content, old_info = members[name]
                info = tarfile.TarInfo(name)
                info.size = len(content)
                info.mode = old_info.mode & 0o777
                info.uid = 0
                info.gid = 0
                info.uname = ""
                info.gname = ""
                info.mtime = 0
                archive.addfile(info, io.BytesIO(content))
    data = output.getvalue()
    if len(data) > MAX_ARCHIVE_BYTES:
        fail("generated derivative exceeds byte limit")
    return data


def source_and_manifest() -> tuple[bytes, dict, dict[str, tuple[bytes, tarfile.TarInfo]]]:
    manifest = load_manifest()
    try:
        with SOURCE_PATH.open("rb") as source_file:
            source_data = source_file.read(MAX_ARCHIVE_BYTES + 1)
    except OSError as error:
        fail(f"official source archive unavailable: {error.__class__.__name__}")
    if len(source_data) > MAX_ARCHIVE_BYTES:
        fail("official source archive exceeds byte limit")
    return source_data, manifest, validate_source(source_data, manifest)


def compressed_fixture(members: dict[str, tuple[bytes, tarfile.TarInfo]]) -> bytes:
    output = io.BytesIO()
    with gzip.GzipFile(fileobj=output, mode="wb", filename="", mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=tarfile.USTAR_FORMAT) as archive:
            for name, (content, old_info) in sorted(members.items()):
                info = tarfile.TarInfo(name)
                info.size = len(content)
                info.mode = old_info.mode & 0o777
                archive.addfile(info, io.BytesIO(content))
    return output.getvalue()


def self_test(fixtures: dict, source_data: bytes, source: dict[str, tuple[bytes, tarfile.TarInfo]], manifest: dict) -> None:
    cases = fixtures.get("cases")
    positive_cases = fixtures.get("positiveCases")
    if fixtures.get("schemaVersion") != 1 or not isinstance(cases, list) or not isinstance(positive_cases, list):
        fail("negative fixture schema invalid")
    actual_fixtures = {item.get("mutation"): item.get("expectedRefusal") for item in cases if isinstance(item, dict)}
    if len(cases) != len(EXPECTED_FIXTURES) or actual_fixtures != EXPECTED_FIXTURES:
        fail("negative fixture inventory differs from the pinned refusal cases")
    actual_positive = {item.get("mutation"): item.get("expectedAcceptance") for item in positive_cases if isinstance(item, dict)}
    if len(positive_cases) != len(EXPECTED_POSITIVE_FIXTURES) or actual_positive != EXPECTED_POSITIVE_FIXTURES:
        fail("positive fixture inventory differs from the pinned acceptance cases")
    expected = patched_members(source, manifest)
    baseline = deterministic_tar(expected)
    for fixture in positive_cases:
        if fixture["mutation"] == "known-positive-derivative":
            validate_derivative(baseline, source, manifest)
        else:
            fail("unknown positive fixture mutation")
    for fixture in fixtures["cases"]:
        if fixture["mutation"] == "missing-official-archive":
            candidate_source = b""
            reject = lambda: validate_source(candidate_source, manifest)
        elif fixture["mutation"] == "tampered-official-archive":
            candidate_source = source_data + b"tamper"
            reject = lambda: validate_source(candidate_source, manifest)
        elif fixture["mutation"] == "wrong-manifest-postimage":
            candidate_manifest = json.loads(json.dumps(manifest))
            candidate_manifest["patch"]["postimageSha256"] = "0" * 64
            reject = lambda: validate_manifest(candidate_manifest)
        elif fixture["mutation"] == "altered-patch-file":
            reject = lambda: validate_manifest(manifest, EXPECTED_PATCH_FILE + b"altered")
        elif fixture["mutation"] == "oversized-compressed-archive":
            reject = lambda: read_archive(b"x" * (MAX_ARCHIVE_BYTES + 1))
        elif fixture["mutation"] == "excessive-raw-expansion":
            payload = io.BytesIO()
            with gzip.GzipFile(fileobj=payload, mode="wb", filename="", mtime=0) as compressed:
                with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
                    info = tarfile.TarInfo("package/pax-payload")
                    info.pax_headers = {"comment": "x" * MAX_RAW_TAR_BYTES}
                    archive.addfile(info, io.BytesIO(b""))
            reject = lambda: read_archive(payload.getvalue())
        elif fixture["mutation"] == "excessive-member-count":
            many = dict(expected)
            for index in range(MAX_MEMBERS + 1 - len(many)):
                name = f"package/fixture-member-limit-{index:02d}"
                info = tarfile.TarInfo(name)
                many[name] = (b"", info)
            reject = lambda: read_archive(compressed_fixture(many))
        else:
            reject = None
        if reject is not None:
            try:
                reject()
                fail(f"negative fixture was accepted: {fixture['id']}")
            except Refusal as error:
                if EXPECTED_FIXTURES[fixture["mutation"]] not in str(error):
                    fail(f"negative fixture rejected for the wrong reason: {fixture['id']}")
            continue
        candidate = dict(expected)
        kind = fixture["mutation"]
        if kind == "extra-member":
            info = tarfile.TarInfo("package/unexpected.bin")
            candidate[info.name] = (b"unexpected", info)
        elif kind == "modified-extra-member":
            name = next(name for name in candidate if name != manifest["patch"]["path"])
            content, info = candidate[name]
            candidate[name] = (content + b"x", info)
        elif kind == "wrong-patch-postimage":
            name = manifest["patch"]["path"]
            content, info = candidate[name]
            candidate[name] = (content.replace(PATCH_LINE, b"                host: 'wrong',\n", 1), info)
        elif kind in ("duplicate-member", "traversal-member", "symlink-member"):
            output = io.BytesIO()
            with tarfile.open(fileobj=output, mode="w:gz", format=tarfile.USTAR_FORMAT) as archive:
                for name in sorted(expected):
                    content, old_info = expected[name]
                    info = tarfile.TarInfo(name)
                    info.size = len(content)
                    info.mode = old_info.mode & 0o777
                    archive.addfile(info, io.BytesIO(content))
                if kind == "duplicate-member":
                    duplicate_name = manifest["patch"]["path"]
                    content, _ = expected[duplicate_name]
                    info = tarfile.TarInfo(duplicate_name)
                elif kind == "symlink-member":
                    content = b""
                    info = tarfile.TarInfo("package/untrusted-link")
                    info.type = tarfile.SYMTYPE
                    info.linkname = "../../escape"
                else:
                    content = b"unexpected"
                    info = tarfile.TarInfo("package/../../escape")
                info.size = len(content)
                archive.addfile(info, io.BytesIO(content))
            malformed = output.getvalue()
        else:
            fail("unknown negative fixture mutation")
        rejected = False
        try:
            data = malformed if kind in ("duplicate-member", "traversal-member", "symlink-member") else deterministic_tar(candidate)
            validate_derivative(data, source, manifest)
        except Refusal as error:
            rejected = True
            if EXPECTED_FIXTURES[fixture["mutation"]] not in str(error):
                fail(f"negative fixture rejected for the wrong reason: {fixture['id']}")
        if not rejected:
            fail(f"negative fixture was accepted: {fixture['id']}")


def emit_base64(data: bytes) -> None:
    digest256 = sha256(data)
    digest512 = hashlib.sha512(data).hexdigest()
    encoded = base64.b64encode(data).decode("ascii")
    chunk_size = 5000
    chunks = [encoded[offset : offset + chunk_size] for offset in range(0, len(encoded), chunk_size)]
    print(f"DERIVATIVE_SHA256={digest256}")
    print(f"DERIVATIVE_SHA512={digest512}")
    print(f"DERIVATIVE_BASE64_PARTS={len(chunks)}")
    for index, chunk in enumerate(chunks, start=1):
        print(f"DERIVATIVE_BASE64_PART {index}/{len(chunks)} {chunk}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("verify-source", "build", "verify-derivative", "self-test", "emit-base64"))
    parser.add_argument("--archive", type=Path, default=DERIVATIVE_PATH)
    args = parser.parse_args()
    try:
        source_data, manifest, source = source_and_manifest()
        if args.command == "verify-source":
            print(f"official source verified sha256={sha256(source_data)} members={len(source)}")
            return 0
        fixtures = json.loads(FIXTURES_PATH.read_text(encoding="utf-8"))
        self_test(fixtures, source_data, source, manifest)
        if args.command == "self-test":
            print(f"negative fixtures rejected count={len(fixtures['cases'])}")
            return 0
        if args.command == "build":
            data = deterministic_tar(patched_members(source, manifest))
            validate_derivative(data, source, manifest)
            args.archive.write_bytes(data)
            print(f"derivative built bytes={len(data)} sha256={sha256(data)} sha512=sha512-{base64.b64encode(hashlib.sha512(data).digest()).decode('ascii')}")
            return 0
        try:
            with args.archive.open("rb") as archive_file:
                data = archive_file.read(MAX_ARCHIVE_BYTES + 1)
        except OSError as error:
            fail(f"derivative unavailable: {error.__class__.__name__}")
        if len(data) > MAX_ARCHIVE_BYTES:
            fail("archive exceeds byte limit")
        validate_derivative(data, source, manifest)
        if args.command == "verify-derivative":
            print(f"derivative verified bytes={len(data)} sha256={sha256(data)}")
        else:
            emit_base64(data)
        return 0
    except (Refusal, OSError, UnicodeError, json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
        print(f"global-agent derivative refused: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
