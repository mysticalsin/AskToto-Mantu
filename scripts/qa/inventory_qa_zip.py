#!/usr/bin/env python3
"""Cloud-only, content-free inventory of one retained QA candidate; not an admission gate."""

import contextlib
import hashlib
import io
import json
import os
import platform
import re
import resource
import shutil
import signal
import stat
import struct
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import warnings
import zipfile
from collections import Counter
from datetime import datetime
from pathlib import Path

REPOSITORY = "mysticalsin/AskToto-Mantu"
REPOSITORY_ID = 1282463398
CANDIDATE_RUN = 37556187965
CANDIDATE_SHA = "723a454a170b93b8c5f2b543b2cc2aa6409645ef"
VARIANT = "mac-qa-identity"
QA_ROOT = "Metis QA.app"
ARTIFACTS = {"qa": (11455409476, "candidate-mac-qa-identity"),
             "provenance": (11455935462, "candidate-provenance")}
MIB = 1024 * 1024
MAX_ARCHIVE = 2 * 1024 * MIB
MAX_METADATA = 16 * MIB
MAX_ENTRIES = 50_000  # Post-parse; metadata reads and RLIMIT_AS bound construction.
MAX_LINK = 4096
MAX_LINK_TOTAL = MIB
MAX_REPORT = 64 * 1024
CHUNK = 64 * 1024
ROOT_PREFIX = "qa-zip-inventory."
OWNER_MARKER = b"qa-zip-inventory-v1\n"
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
ERROR_CODES = frozenset("""DEADLINE BYTE_LIMIT URL_INVALID AUTH_HOST HTTP_STATUS REDIRECT_LIMIT
CHECKER_IDENTITY RUN_IDENTITY ARTIFACT_LIST ARTIFACT_IDENTITY ARTIFACT_EXPIRED ARTIFACT_SIZE
ARTIFACT_DIGEST OWNED_ROOT REGULAR_FILE TOKEN_MISSING OUTER_DIGEST METADATA_LIMIT ENTRY_LIMIT
OUTER_MEMBERS OUTER_TYPE OUTER_ENCODING PROVENANCE_IDENTITY PROVENANCE_VERSION PROVENANCE_VARIANT
PROVENANCE_ASSET PROVENANCE_SIZE INNER_SIZE INNER_DIGEST EXTRA_INVALID LINK_SIZE BINDING_INVALID
HOST_ONLY USAGE REPORT_LIMIT""".split())


class InventoryError(Exception):
    """Only constant codes, never input strings, cross the CLI boundary."""


def require(condition, code):
    if not condition:
        raise InventoryError(code)


def remaining(deadline):
    value = deadline - time.monotonic()
    require(value > 0, "DEADLINE")
    return value


def copy_bounded(source, sink, cap, deadline):
    digest = hashlib.sha256()
    total = 0
    while True:
        remaining(deadline)
        chunk = source.read(min(CHUNK, cap - total + 1))
        if not chunk:
            break
        total += len(chunk)
        require(total <= cap, "BYTE_LIMIT")
        digest.update(chunk)
        sink.write(chunk)
    return total, digest.hexdigest()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def https_url(url):
    require(isinstance(url, str) and len(url) <= 8192, "URL_INVALID")
    parsed = urllib.parse.urlsplit(url)
    require(parsed.scheme == "https" and bool(parsed.hostname)
            and parsed.username is None and parsed.password is None
            and parsed.port in (None, 443) and not parsed.fragment, "URL_INVALID")
    return parsed


def fetch(url, sink, cap, deadline, token=None, opener=None):
    """Only the initial fixed GitHub API request receives authentication."""
    opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    for redirects in range(4):
        parsed = https_url(url)
        request = urllib.request.Request(url, headers={
            "User-Agent": "metis-qa-zip-inventory", "Accept": "application/vnd.github+json"})
        if token is not None:
            require(parsed.hostname == "api.github.com", "AUTH_HOST")
            request.add_unredirected_header("Authorization", "Bearer " + token)
        token = None
        try:
            response = opener.open(request, timeout=min(20, remaining(deadline)))
        except urllib.error.HTTPError as error:
            location = error.headers.get("Location") if error.headers else None
            code = error.code
            error.close()  # No unbounded redirect/error-body drain, and no URL in diagnostics.
            require(code in (301, 302, 303, 307, 308) and redirects < 3, "HTTP_STATUS")
            https_url(location)
            url = location
            continue
        with response:
            require(response.status == 200, "HTTP_STATUS")
            return copy_bounded(response, sink, cap, deadline)
    raise InventoryError("REDIRECT_LIMIT")


def api_json(path, token, deadline):
    data = io.BytesIO()
    fetch("https://api.github.com/" + path, data, MIB, deadline, token)
    return json.loads(data.getvalue())


def checker_identity(env):
    require(re.fullmatch(r"[0-9a-f]{40}", env.get("GITHUB_SHA", "")) is not None,
            "CHECKER_IDENTITY")
    run = env.get("GITHUB_RUN_ID", "")
    attempt = env.get("GITHUB_RUN_ATTEMPT", "")
    require(re.fullmatch(r"[1-9][0-9]{0,19}", run) is not None
            and re.fullmatch(r"[1-9][0-9]{0,5}", attempt) is not None, "CHECKER_IDENTITY")
    return {"commit": env["GITHUB_SHA"], "run": int(run), "attempt": int(attempt)}


def validate_api(run, listing):
    require(run["id"] == CANDIDATE_RUN and run["repository"]["full_name"] == REPOSITORY
            and run["repository"]["id"] == REPOSITORY_ID
            and run["head_repository"]["id"] == REPOSITORY_ID
            and run["head_sha"] == CANDIDATE_SHA and run["head_branch"] == "main"
            and run["path"] == ".github/workflows/qa-candidate.yml"
            and run["event"] == "workflow_dispatch"
            and run["status"] == "completed" and run["conclusion"] == "success", "RUN_IDENTITY")
    records = listing["artifacts"]
    require(isinstance(records, list) and len(records) == listing["total_count"]
            and len(records) <= 100, "ARTIFACT_LIST")
    result = {}
    for label, (artifact_id, name) in ARTIFACTS.items():
        matches = [item for item in records if item.get("id") == artifact_id or item.get("name") == name]
        require(len(matches) == 1, "ARTIFACT_IDENTITY")
        item = matches[0]
        origin = item["workflow_run"]
        require(item["id"] == artifact_id and item["name"] == name and item["expired"] is False
                and origin["id"] == CANDIDATE_RUN and origin["head_sha"] == CANDIDATE_SHA
                and origin["repository_id"] == REPOSITORY_ID
                and origin["head_repository_id"] == REPOSITORY_ID, "ARTIFACT_IDENTITY")
        require(datetime.fromisoformat(item["expires_at"].replace("Z", "+00:00")).timestamp() > time.time(),
                "ARTIFACT_EXPIRED")
        cap = MAX_ARCHIVE if label == "qa" else MIB
        require(type(item["size_in_bytes"]) is int and 0 < item["size_in_bytes"] <= cap, "ARTIFACT_SIZE")
        digest = item.get("digest", "")
        require(isinstance(digest, str) and re.fullmatch(r"sha256:[0-9a-f]{64}", digest) is not None,
                "ARTIFACT_DIGEST")
        result[label] = {"id": artifact_id, "size": item["size_in_bytes"], "sha256": digest[7:]}
    return result


def exclusive(path):
    return os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), "wb")


def owned_root(path, runner_temp):
    root = Path(path)
    base = Path(runner_temp).resolve(strict=True)
    require(root.is_absolute() and root.parent == base and root.resolve(strict=True) == root
            and re.fullmatch(r"qa-zip-inventory\.[a-z0-9_]{8,}", root.name) is not None, "OWNED_ROOT")
    info = root.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
            and stat.S_IMODE(info.st_mode) == 0o700, "OWNED_ROOT")
    with regular_file(root / ".owner") as stream:
        require(stream.read(len(OWNER_MARKER) + 1) == OWNER_MARKER, "OWNED_ROOT")
    return root


@contextlib.contextmanager
def regular_file(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, "REGULAR_FILE")
        yield stream


def cleanup(path, runner_temp):
    shutil.rmtree(owned_root(path, runner_temp))


def download(env, deadline):
    token = env.get("GH_TOKEN", "")
    require(bool(token), "TOKEN_MISSING")
    checker = checker_identity(env)
    api = "repos/" + REPOSITORY + "/actions/runs/" + str(CANDIDATE_RUN)
    artifacts = validate_api(api_json(api, token, deadline),
                             api_json(api + "/artifacts?per_page=100", token, deadline))
    root = Path(tempfile.mkdtemp(prefix=ROOT_PREFIX, dir=Path(env["RUNNER_TEMP"]).resolve(strict=True)))
    try:
        with exclusive(root / ".owner") as stream:
            stream.write(OWNER_MARKER)
        for label, record in artifacts.items():
            with exclusive(root / (label + ".outer.zip")) as stream:
                count, digest = fetch("https://api.github.com/repos/" + REPOSITORY
                                      + "/actions/artifacts/" + str(record["id"]) + "/zip",
                                      stream, record["size"], deadline, token)
            require(count == record["size"] and digest == record["sha256"], "OUTER_DIGEST")
        with exclusive(root / "binding.json") as stream:
            stream.write(json.dumps({"checker": checker, "artifacts": artifacts}).encode("ascii"))
        # Only a locally created path crosses steps; no API or archive strings do.
        with open(env["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
            output.write("root=" + str(root) + "\n")
    except BaseException:
        shutil.rmtree(root)
        raise


class MetadataReader:
    """Bound ZipFile's central-directory allocation, then allow only small payload reads."""
    def __init__(self, stream, cap=MAX_METADATA):
        self.stream = stream
        self.cap = cap
        self.metadata = True
        self.total = 0

    def seek(self, offset, whence=0):
        return self.stream.seek(offset, whence)

    def tell(self):
        return self.stream.tell()

    def seekable(self):
        return True

    def read(self, size=-1):
        if size < 0:
            position = self.tell()
            end = self.seek(0, 2)
            self.seek(position)
            size = end - position
        require(0 <= size <= (self.cap if self.metadata else CHUNK), "METADATA_LIMIT")
        if self.metadata:
            self.total += size
            require(self.total <= self.cap + 128 * 1024, "METADATA_LIMIT")
        return self.stream.read(size)


@contextlib.contextmanager
def archive(path):
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        with regular_file(path) as stream:
            reader = MetadataReader(stream)
            with zipfile.ZipFile(reader) as zipped:
                require(len(zipped.infolist()) <= MAX_ENTRIES, "ENTRY_LIMIT")
                reader.metadata = False
                yield zipped


def outer_entries(zipped, expected):
    entries = zipped.infolist()
    require(len(entries) == len(expected) and {entry.orig_filename for entry in entries} == set(expected),
            "OUTER_MEMBERS")
    for entry in entries:
        mode = entry.external_attr >> 16
        require(entry.orig_filename == entry.filename and not entry.is_dir()
                and not entry.external_attr & 0x10 and entry.create_system in (0, 3)
                and stat.S_IFMT(mode) in (0, stat.S_IFREG), "OUTER_TYPE")
        require(not entry.flag_bits & 0x41 and entry.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED),
                "OUTER_ENCODING")
    return {entry.filename: entry for entry in entries}


def provenance_asset(value):
    require(value["schema"] == 1 and value["repository"] == REPOSITORY
            and value["commit"] == CANDIDATE_SHA and value["run"]["id"] == CANDIDATE_RUN,
            "PROVENANCE_IDENTITY")
    version = value["version"]
    require(isinstance(version, str) and re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?", version)
            and len(version) <= 80, "PROVENANCE_VERSION")
    name = "Metis-QA-" + version + ".zip"
    builds = value["builds"]
    selected = [build for build in builds if build.get("variant") == VARIANT]
    require(len(selected) == 1 and selected[0].get("artifact") == "candidate-mac-qa-identity"
            and len(selected[0]["assets"]) == 1, "PROVENANCE_VARIANT")
    matches = [asset for build in builds for asset in build["assets"] if asset.get("name") == name]
    require(len(matches) == 1 and selected[0]["assets"][0] == matches[0], "PROVENANCE_ASSET")
    asset = matches[0]
    require(type(asset["size"]) is int and 0 < asset["size"] <= MAX_ARCHIVE
            and isinstance(asset["sha256"], str) and SHA256.fullmatch(asset["sha256"]), "PROVENANCE_ASSET")
    return asset


def prepare_inner(root, deadline):
    with archive(root / "provenance.outer.zip") as zipped:
        entries = outer_entries(zipped, ["provenance.json", "SHA256SUMS.txt"])
        require(all(entry.file_size <= MIB for entry in entries.values()), "PROVENANCE_SIZE")
        data = io.BytesIO()
        with zipped.open(entries["provenance.json"]) as source:
            copy_bounded(source, data, MIB, deadline)
        asset = provenance_asset(json.loads(data.getvalue()))
    with archive(root / "qa.outer.zip") as zipped:
        entry = outer_entries(zipped, [asset["name"]])[asset["name"]]
        require(entry.file_size == asset["size"], "INNER_SIZE")
        with zipped.open(entry) as source, exclusive(root / "candidate.zip") as target:
            count, digest = copy_bounded(source, target, asset["size"], deadline)
        require(count == asset["size"] and digest == asset["sha256"], "INNER_DIGEST")
    return {"size": asset["size"], "sha256": asset["sha256"], "variant": VARIANT}


def safe_ascii_name(entry):
    name = entry.orig_filename
    if (name != entry.filename or not name.isascii() or len(name) > 4096
            or any(ord(char) < 32 or ord(char) == 127 for char in name)
            or "\\" in name or ":" in name):
        return None
    parts = name.rstrip("/").split("/")
    return "/".join(parts) if len(parts) <= 128 and all(part not in ("", ".", "..") for part in parts) else None


def inventory(path, deadline):
    counts = Counter(dict.fromkeys("""entries utf8FlagEntries descriptorFlagEntries asciiOriginalNames
legacyNonAsciiNames changedNames zip64ExtraFields expectedRootEntries otherRootEntries traversalNames
unresolvedNames links linkPayloadsRead asciiLinkTargets absoluteLinkTargets relativeLinkTargets
linkTargetsWithParentComponents unknownLinkEncoding unreadLinkPayloads""".split(), 0))
    distributions = {key: Counter() for key in ("methods", "flags", "creatorSystems", "unixModes", "unixTypes", "extraIds")}
    names, links, originals, folded = [], set(), Counter(), Counter()
    with archive(path) as zipped:
        entries = zipped.infolist()
        compressed = expanded = link_bytes = 0
        for entry in entries:
            remaining(deadline)
            counts["entries"] += 1
            compressed += entry.compress_size
            expanded += entry.file_size
            for key, value in (("methods", entry.compress_type), ("flags", entry.flag_bits), ("creatorSystems", entry.create_system)):
                distributions[key][str(value)] += 1
            mode = entry.external_attr >> 16
            if entry.create_system == 3:
                distributions["unixModes"][format(mode & 0o7777, "04o")] += 1
                distributions["unixTypes"][format(stat.S_IFMT(mode), "06o")] += 1
            counts["utf8FlagEntries"] += bool(entry.flag_bits & 0x800)
            counts["descriptorFlagEntries"] += bool(entry.flag_bits & 8)
            counts["asciiOriginalNames"] += entry.orig_filename.isascii()
            counts["legacyNonAsciiNames"] += not entry.orig_filename.isascii() and not entry.flag_bits & 0x800
            counts["changedNames"] += entry.orig_filename != entry.filename
            extra = entry.extra
            while extra:
                require(len(extra) >= 4, "EXTRA_INVALID")
                kind, size = struct.unpack_from("<HH", extra)
                require(size <= len(extra) - 4, "EXTRA_INVALID")
                distributions["extraIds"][format(kind, "04x")] += 1
                counts["zip64ExtraFields"] += kind == 1
                extra = extra[4 + size:]
            originals[entry.orig_filename] += 1
            if entry.orig_filename.isascii():
                folded[entry.orig_filename.lower()] += 1
            counts["expectedRootEntries"] += entry.orig_filename.split("/", 1)[0] == QA_ROOT
            counts["otherRootEntries"] += entry.orig_filename.split("/", 1)[0] != QA_ROOT
            counts["traversalNames"] += ".." in entry.orig_filename.split("/")
            name = safe_ascii_name(entry)
            if name is None:
                counts["unresolvedNames"] += 1
            else:
                names.append(name)
            if entry.create_system != 3 or not stat.S_ISLNK(mode):
                continue
            counts["links"] += 1
            if name is not None:
                links.add(name)
            if (name is not None and entry.file_size <= MAX_LINK and entry.compress_size <= CHUNK
                    and link_bytes + entry.file_size <= MAX_LINK_TOTAL
                    and entry.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
                    and not entry.flag_bits & 0x41):
                data = io.BytesIO()
                with zipped.open(entry) as source:
                    size, _ = copy_bounded(source, data, MAX_LINK, deadline)
                require(size == entry.file_size, "LINK_SIZE")
                link_bytes += size
                raw = data.getvalue()
                counts["linkPayloadsRead"] += 1
                if raw and raw.isascii() and all(32 <= byte < 127 for byte in raw) and b"\\" not in raw and b":" not in raw:
                    target = raw.decode("ascii")
                    counts["asciiLinkTargets"] += 1
                    counts["absoluteLinkTargets"] += target.startswith("/")
                    counts["relativeLinkTargets"] += not target.startswith("/")
                    counts["linkTargetsWithParentComponents"] += ".." in target.split("/")
                else:
                    counts["unknownLinkEncoding"] += 1
            else:
                counts["unreadLinkPayloads"] += 1
        counts["duplicateNames"] = sum(value - 1 for value in originals.values())
        counts["asciiCaseConflicts"] = sum(value - 1 for value in folded.values()) - sum(value - 1 for name, value in originals.items() if name.isascii())
        counts["symlinkAncestorEntries"] = sum(any("/".join(name.split("/")[:index]) in links
                                                     for index in range(1, len(name.split("/"))))
                                                for name in names)
    incomplete = counts["unreadLinkPayloads"] or counts["unknownLinkEncoding"] or counts["unresolvedNames"]
    return {"status": "INCOMPLETE" if incomplete else "COMPLETE",
            "scope": "CENTRAL_DIRECTORY_AND_BOUNDED_LINK_PAYLOADS", "expectedRoot": QA_ROOT,
            "localHeaders": "NOT_INSPECTED", "extractionAdmission": "NOT_ASSESSED",
            "counts": dict(sorted(counts.items())), "distributions": {key: dict(sorted(value.items())) for key, value in distributions.items()},
            "linkGraph": "NOT_ANALYSED", "graphCoverage": "UNKNOWN", "linkResolutionUnknownCount": counts["links"],
            "linkPayloadBytesRead": link_bytes,
            "declaredCompressedBytes": str(compressed), "declaredExpandedBytes": str(expanded)}


def inventory_download(root, env, deadline):
    root = owned_root(root, env["RUNNER_TEMP"])
    with regular_file(root / "binding.json") as stream:
        raw = stream.read(MIB + 1)
    require(len(raw) <= MIB, "BINDING_INVALID")
    binding = json.loads(raw)
    checker = checker_identity(env)
    require(binding["checker"] == checker, "CHECKER_IDENTITY")
    artifacts = {}
    for label, (artifact_id, _) in ARTIFACTS.items():
        record = binding["artifacts"][label]
        require(record["id"] == artifact_id and SHA256.fullmatch(record["sha256"])
                and type(record["size"]) is int and 0 < record["size"] <= (MAX_ARCHIVE if label == "qa" else MIB), "BINDING_INVALID")
        with regular_file(root / (label + ".outer.zip")) as source:
            count, digest = copy_bounded(source, Discard(), record["size"], deadline)
        require(count == record["size"] and digest == record["sha256"], "OUTER_DIGEST")
        artifacts[label] = {"id": artifact_id, "size": count, "sha256": digest}
    inner = prepare_inner(root, deadline)
    report = inventory(root / "candidate.zip", deadline)
    report.update({"schema": 1, "checker": checker, "repository": REPOSITORY,
                   "candidateRun": CANDIDATE_RUN, "candidateCommit": CANDIDATE_SHA,
                   "outerArtifacts": artifacts, "innerArchive": inner,
                   "runtime": {"runnerImage": "ubuntu-24.04", "python": list(sys.version_info[:3]),
                               "platform": sys.platform, "machine": platform.machine() if platform.machine() in ("x86_64", "aarch64") else "UNKNOWN"}})
    return report


class Discard:
    def write(self, data):
        return len(data)


def cli(argv, env):
    root = None
    try:
        require(sys.platform == "linux" and sys.version_info[:2] == (3, 12)
                and env.get("GITHUB_ACTIONS") == "true" and env.get("RUNNER_ENVIRONMENT") == "github-hosted"
                and env.get("GITHUB_REPOSITORY") == REPOSITORY, "HOST_ONLY")
        require(argv in (["download"],) or (len(argv) == 2 and argv[0] in ("inventory", "cleanup")), "USAGE")
        resource.setrlimit(resource.RLIMIT_AS, (768 * MIB, 768 * MIB))
        seconds = 900 if argv[0] == "download" else 180
        def expired(signum, frame):
            raise InventoryError("DEADLINE")
        signal.signal(signal.SIGALRM, expired)
        signal.alarm(seconds)
        with warnings.catch_warnings():
            warnings.simplefilter("error")
            if argv[0] == "download":
                download(env, time.monotonic() + seconds)
                print("QA_ARCHIVE_DOWNLOAD_COMPLETE")
                return 0
            root = owned_root(argv[1], env["RUNNER_TEMP"])
            if argv[0] == "cleanup":
                cleanup(root, env["RUNNER_TEMP"])
                return 0
            report = inventory_download(root, env, time.monotonic() + seconds)
            encoded = json.dumps(report, sort_keys=True).encode("ascii")
            require(len(encoded) <= MAX_REPORT, "REPORT_LIMIT")
            with exclusive(root / "inventory.json") as stream:
                stream.write(encoded + b"\n")
            print("QA_ARCHIVE_INVENTORY_" + report["status"])
            return 0 if report["status"] == "COMPLETE" else 1
    except Exception as error:
        code = error.args[0] if (isinstance(error, InventoryError) and error.args
                                and isinstance(error.args[0], str) and error.args[0] in ERROR_CODES) else "INVALID_OR_UNSUPPORTED"
        failure = {"schema": 1, "status": "INCOMPLETE", "error": code,
                   "extractionAdmission": "NOT_ASSESSED"}
        if root is not None and argv[0] == "inventory":
            with contextlib.suppress(Exception):
                with exclusive(root / "inventory.json") as stream:
                    stream.write(json.dumps(failure).encode("ascii") + b"\n")
        print("QA_ARCHIVE_INVENTORY_INCOMPLETE " + code, file=sys.stderr)
        return 1
    finally:
        signal.alarm(0)


if __name__ == "__main__":
    raise SystemExit(cli(sys.argv[1:], os.environ))
