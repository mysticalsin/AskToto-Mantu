#!/usr/bin/env python3
"""Bounded hosted archive validation; never app identity, admission or launch proof."""

import contextlib
import json
import os
import resource
import shutil
import signal
import stat
import struct
import sys
import tempfile
import time
import warnings
import zipfile
from pathlib import Path

from inventory_qa_zip import (
    CHUNK, ERROR_CODES as INVENTORY_ERRORS, MAX_ARCHIVE, MAX_LINK, MAX_LINK_TOTAL,
    MAX_REPORT, MIB, QA_ROOT, REPOSITORY, InventoryError, archive, exclusive,
    inventory_download, owned_root, remaining, require,
)

MAX_OUTPUT = 4 * 1024 * MIB
MAX_RESOLVE_OPERATIONS = 1_000_000
MAX_EXPANSIONS = 32
STAGE_PREFIX = "qa-extracted."
ERROR_CODES = INVENTORY_ERRORS | frozenset("""ARCHIVE_LIMIT PATH_INVALID ROOT_INVALID
PATH_COLLISION ENTRY_TYPE ENTRY_MODE ENTRY_ENCODING DIRECTORY_PAYLOAD EXTRA_UNSUPPORTED
LOCAL_HEADER LOCAL_NAME LOCAL_FIELDS LOCAL_RANGE LOCAL_OVERLAP LINK_LIMIT LINK_TARGET
LINK_ESCAPE LINK_DANGLING LINK_INTERMEDIATE LINK_CYCLE LINK_EXPANSIONS LINK_OPERATIONS
OUTPUT_LIMIT OUTPUT_SIZE TREE_INVALID CLEANUP_FAILED REPORT_WRITE_FAILED""".split())


def entry_path(info):
    name = info.orig_filename
    require(name == info.filename and name.isascii() and 0 < len(name) <= 4096
            and all(32 <= ord(char) < 127 for char in name)
            and "\\" not in name and ":" not in name, "PATH_INVALID")
    parts = (name[:-1] if name.endswith("/") else name).split("/")
    require(len(parts) <= 128 and all(part not in ("", ".", "..") for part in parts), "PATH_INVALID")
    require(parts[0] == QA_ROOT, "ROOT_INVALID")
    mode = info.external_attr >> 16
    kind = stat.S_IFMT(mode)
    require(info.create_system == 3 and kind in (stat.S_IFDIR, stat.S_IFREG, stat.S_IFLNK), "ENTRY_TYPE")
    require(not mode & 0o7000, "ENTRY_MODE")
    if kind == stat.S_IFDIR:
        require(mode & 0o777 == 0o755 and name.endswith("/"), "ENTRY_MODE")
        require(info.compress_type == zipfile.ZIP_STORED and info.file_size == 0
                and info.compress_size == 0 and info.CRC == 0, "DIRECTORY_PAYLOAD")
    else:
        require(not name.endswith("/"), "ENTRY_TYPE")
        if kind == stat.S_IFREG:
            require(mode & 0o777 in (0o644, 0o755), "ENTRY_MODE")
    require(info.flag_bits == 0 and info.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
            and info.extract_version in (10, 20) and info.reserved == 0, "ENTRY_ENCODING")
    require(0 <= info.file_size < 0xFFFFFFFF and 0 <= info.compress_size < 0xFFFFFFFF
            and 0 <= info.header_offset < 0xFFFFFFFF, "ENTRY_ENCODING")
    if info.compress_type == zipfile.ZIP_STORED:
        require(info.file_size == info.compress_size, "ENTRY_ENCODING")
    return "/".join(parts), kind, mode & 0o777


def extras(raw, local=False):
    seen = set()
    while raw:
        require(len(raw) >= 4, "EXTRA_INVALID")
        kind, size = struct.unpack_from("<HH", raw)
        require(size <= len(raw) - 4 and kind not in seen, "EXTRA_INVALID")
        require(kind in (0x5455, 0x7875), "EXTRA_UNSUPPORTED")
        seen.add(kind)
        value, raw = raw[4:4 + size], raw[4 + size:]
        if kind == 0x5455:
            require(bool(value) and not value[0] & ~7, "EXTRA_INVALID")
            expected = 1 + 4 * value[0].bit_count()
            # Central UT fields may retain only mtime even when their flags also name atime/ctime.
            require(len(value) == expected if local else len(value) in (expected, 1 + 4 * (value[0] & 1)),
                    "EXTRA_INVALID")
        else:
            require(len(value) >= 3 and value[0] == 1 and 1 <= value[1] <= 8, "EXTRA_INVALID")
            gid = 2 + value[1]
            require(gid < len(value) and 1 <= value[gid] <= 8
                    and len(value) == gid + 1 + value[gid], "EXTRA_INVALID")


def read_exact(stream, size):
    require(0 <= size <= CHUNK, "LOCAL_HEADER")
    data = stream.read(size)
    require(len(data) == size, "LOCAL_HEADER")
    return data


def local_interval(zipped, info, central):
    require(0 <= info.header_offset <= central - 30, "LOCAL_RANGE")
    stream = zipped.fp
    stream.seek(info.header_offset)
    fields = struct.unpack("<4s5H3I2H", read_exact(stream, 30))
    signature, version, flags, method, _, _, crc, compressed, expanded, name_size, extra_size = fields
    require(signature == b"PK\x03\x04", "LOCAL_HEADER")
    require(version == info.extract_version and flags == info.flag_bits and method == info.compress_type
            and crc == info.CRC and compressed == info.compress_size and expanded == info.file_size,
            "LOCAL_FIELDS")
    require(name_size <= 4096 and info.header_offset + 30 + name_size + extra_size <= central, "LOCAL_RANGE")
    require(read_exact(stream, name_size) == info.orig_filename.encode("ascii"), "LOCAL_NAME")
    extras(read_exact(stream, extra_size), local=True)
    end = stream.tell() + compressed
    require(end <= central, "LOCAL_RANGE")
    return info.header_offset, end


def link_parts(target):
    require(bool(target) and len(target) <= MAX_LINK and target.isascii()
            and all(32 <= ord(char) < 127 for char in target)
            and not target.startswith("/") and "\\" not in target and ":" not in target, "LINK_TARGET")
    parts = target.split("/")
    require(all(parts[index] for index in range(len(parts) - 1)), "LINK_TARGET")
    return parts


def resolve_links(nodes, links, deadline):
    operations = 0
    resolved = {}
    for name, target in links.items():
        expansions = 1  # Include the initial link, not only nested expansions.
        def walk(current, pending, active):
            nonlocal operations, expansions
            for component in pending:
                remaining(deadline)
                operations += 1
                require(operations <= MAX_RESOLVE_OPERATIONS, "LINK_OPERATIONS")
                require(nodes.get("/".join(current)) == stat.S_IFDIR, "LINK_INTERMEDIATE")
                if component in ("", "."):
                    continue
                if component == "..":
                    require(len(current) > 1, "LINK_ESCAPE")
                    current = current[:-1]
                    continue
                path = "/".join(current + [component])
                kind = nodes.get(path)
                require(kind is not None, "LINK_DANGLING")
                if kind == stat.S_IFLNK:
                    require(path not in active, "LINK_CYCLE")
                    expansions += 1
                    require(expansions <= MAX_EXPANSIONS, "LINK_EXPANSIONS")
                    current = walk(current, link_parts(links[path]), active | {path})
                else:
                    current = current + [component]
            return current
        resolved[name] = "/".join(walk(name.split("/")[:-1], link_parts(target), {name}))
    return resolved


def preflight(zipped, deadline, progress):
    progress["localHeaders"] = "FAIL"
    remaining(deadline)
    central = zipped.start_dir
    size = zipped.fp.seek(0, 2)
    require(0 <= central <= size <= MAX_ARCHIVE, "ARCHIVE_LIMIT")
    entries, nodes, spelling, links, intervals = [], {}, {}, {}, []
    declared = 0
    explicit = set()
    for info in zipped.infolist():
        remaining(deadline)
        name, kind, mode = entry_path(info)
        require(name not in explicit, "PATH_COLLISION")
        explicit.add(name)
        parts = name.split("/")
        for index in range(1, len(parts) + 1):
            path = "/".join(parts[:index])
            node_kind = kind if index == len(parts) else stat.S_IFDIR
            require(spelling.get(path.lower(), path) == path
                    and nodes.get(path, node_kind) == node_kind, "PATH_COLLISION")
            spelling[path.lower()] = path
            nodes[path] = node_kind
        extras(info.extra)
        intervals.append(local_interval(zipped, info, central))
        declared += info.file_size
        require(declared <= MAX_OUTPUT, "OUTPUT_LIMIT")
        entries.append((name, kind, mode, info))
    require(nodes.get(QA_ROOT) == stat.S_IFDIR and bool(entries), "ROOT_INVALID")
    previous_end = 0
    for start, end in sorted(intervals):
        require(start >= previous_end, "LOCAL_OVERLAP")
        previous_end = end
    progress["localHeaders"] = "PASS"
    progress["linkGraph"] = "FAIL"
    link_bytes = 0
    for name, kind, _, info in entries:
        if kind != stat.S_IFLNK:
            continue
        require(info.file_size <= MAX_LINK and info.compress_size <= CHUNK
                and link_bytes + info.file_size <= MAX_LINK_TOTAL, "LINK_LIMIT")
        with zipped.open(info) as source:
            remaining(deadline)
            payload = source.read(MAX_LINK + 1)
            require(len(payload) == info.file_size and not source.read(1), "LINK_SIZE")
        require(payload.isascii(), "LINK_TARGET")
        target = payload.decode("ascii")
        link_parts(target)
        links[name] = target
        link_bytes += len(payload)
    resolved = resolve_links(nodes, links, deadline)
    progress["linkGraph"] = "PASS"
    progress.update({"entries": len(entries), "directories": sum(kind == stat.S_IFDIR for kind in nodes.values()),
                     "files": sum(kind == stat.S_IFREG for kind in nodes.values()), "links": len(links),
                     "declaredBytes": declared})
    return entries, nodes, links, resolved, link_bytes


@contextlib.contextmanager
def directory_fd(stage, parts):
    fd = os.open(stage, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for component in [None] + list(parts):
            if component is not None:
                next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = next_fd
            info = os.fstat(fd)
            require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid(), "TREE_INVALID")
        yield fd
    finally:
        os.close(fd)


def copy_file(source, target, expected, progress, deadline):
    count = 0
    while True:
        remaining(deadline)
        data = source.read(min(CHUNK, expected - count + 1))
        if not data:
            break
        count += len(data)
        require(count <= expected, "OUTPUT_SIZE")
        require(progress["actualBytes"] + len(data) <= MAX_OUTPUT, "OUTPUT_LIMIT")
        target.write(data)
        progress["actualBytes"] += len(data)
    require(count == expected, "OUTPUT_SIZE")


def remove_stage(stage, root):
    try:
        require(shutil.rmtree.avoids_symlink_attacks, "CLEANUP_FAILED")
        info = stage.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
                and stage.parent == root and stage.name.startswith(STAGE_PREFIX), "CLEANUP_FAILED")
        shutil.rmtree(stage)
    except BaseException:
        raise InventoryError("CLEANUP_FAILED") from None


def extract_archive(root, runner_temp, deadline, progress=None):
    root = owned_root(root, runner_temp)
    progress = progress if progress is not None else {}
    progress.update({"localHeaders": "NOT_RUN", "linkGraph": "NOT_RUN", "materialization": "NOT_RUN"})
    stage = None
    try:
        with archive(root / "candidate.zip") as zipped:
            entries, nodes, links, resolved, link_bytes = preflight(zipped, deadline, progress)
            remaining(deadline)
            progress["materialization"] = "FAIL"
            stage = Path(tempfile.mkdtemp(prefix=STAGE_PREFIX, dir=root))
            progress["actualBytes"] = link_bytes
            for name in sorted((path for path, kind in nodes.items() if kind == stat.S_IFDIR),
                               key=lambda path: (path.count("/"), path)):
                remaining(deadline)
                parts = name.split("/")
                with directory_fd(stage, parts[:-1]) as parent:
                    os.mkdir(parts[-1], 0o700, dir_fd=parent)
            for name, kind, mode, info in entries:
                if kind != stat.S_IFREG:
                    continue
                parts = name.split("/")
                with directory_fd(stage, parts[:-1]) as parent:
                    fd = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
                    with os.fdopen(fd, "wb") as target, zipped.open(info) as source:
                        copy_file(source, target, info.file_size, progress, deadline)
                        os.fchmod(target.fileno(), mode)
            # No archive link exists while any payload file or directory is being written.
            for name, target in links.items():
                remaining(deadline)
                parts = name.split("/")
                with directory_fd(stage, parts[:-1]) as parent:
                    os.symlink(target, parts[-1], dir_fd=parent)
            for name, kind in nodes.items():
                remaining(deadline)
                parts = name.split("/")
                with directory_fd(stage, parts[:-1]) as parent:
                    info = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
                    require(stat.S_IFMT(info.st_mode) == kind and info.st_uid == os.getuid(), "TREE_INVALID")
                    if kind == stat.S_IFLNK:
                        require(os.readlink(parts[-1], dir_fd=parent) == links[name], "TREE_INVALID")
                    elif kind == stat.S_IFREG:
                        require(info.st_nlink == 1, "TREE_INVALID")
                if kind == stat.S_IFDIR:
                    with directory_fd(stage, parts) as directory:
                        os.fchmod(directory, 0o755)
            require(resolve_links(nodes, links, deadline) == resolved, "TREE_INVALID")
            progress["materialization"] = "PASS"
            # ZipExtFile bounds emitted bytes and checks CRC. It does not prove that all compressed
            # DEFLATE input was consumed after reaching the declared output size.
            progress["deflateConsumption"] = "NOT_PROVEN"
            return stage, progress
    except BaseException:
        if stage is not None:
            remove_stage(stage, root)
        raise


def error_code(error):
    return (error.args[0] if isinstance(error, InventoryError) and error.args
            and isinstance(error.args[0], str) and error.args[0] in ERROR_CODES else "INVALID_OR_UNSUPPORTED")


def write_report(root, report):
    encoded = json.dumps(report, sort_keys=True).encode("ascii")
    require(len(encoded) <= MAX_REPORT, "REPORT_LIMIT")
    with exclusive(root / "inventory.json") as stream:
        stream.write(encoded + b"\n")


def cli(argv, env):
    root = None
    stage = None
    report = {"schema": 1, "status": "FAIL", "scope": "ARCHIVE_VALIDATION_ONLY",
              "metadataInventory": {"status": "NOT_COMPLETED"},
              "extraction": {"localHeaders": "NOT_RUN", "linkGraph": "NOT_RUN", "materialization": "NOT_RUN"},
              "appIdentity": "NOT_ASSESSED", "appLaunch": "NOT_RUN"}
    try:
        require(sys.platform == "linux" and sys.version_info[:2] == (3, 12)
                and env.get("GITHUB_ACTIONS") == "true" and env.get("RUNNER_ENVIRONMENT") == "github-hosted"
                and env.get("GITHUB_REPOSITORY") == REPOSITORY, "HOST_ONLY")
        require(len(argv) == 1, "USAGE")
        resource.setrlimit(resource.RLIMIT_AS, (768 * MIB, 768 * MIB))
        def expired(signum, frame):
            raise InventoryError("DEADLINE")
        signal.signal(signal.SIGALRM, expired)
        signal.alarm(600)
        deadline = time.monotonic() + 600
        with warnings.catch_warnings():
            warnings.simplefilter("error")
            root = owned_root(argv[0], env["RUNNER_TEMP"])
            report["metadataInventory"] = inventory_download(root, env, deadline)
            stage, _ = extract_archive(root, env["RUNNER_TEMP"], deadline, report["extraction"])
            report["status"] = "PASS"
            write_report(root, report)
        print("QA_ARCHIVE_VALIDATION_PASS")
        return 0
    except Exception as error:
        code = error_code(error)
        if stage is not None:
            try:
                remove_stage(stage, root)
            except InventoryError:
                code = "CLEANUP_FAILED"
        report["status"] = "FAIL"
        report["error"] = code
        if root is not None:
            try:
                write_report(root, report)
            except Exception:
                print("QA_ARCHIVE_VALIDATION_FAIL REPORT_WRITE_FAILED", file=sys.stderr)
        print("QA_ARCHIVE_VALIDATION_FAIL " + code, file=sys.stderr)
        return 1
    finally:
        signal.alarm(0)


if __name__ == "__main__":
    raise SystemExit(cli(sys.argv[1:], os.environ))
