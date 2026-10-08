"""Fixed-path QA identity checks on a live private extraction stage; no app launch."""

import contextlib
import json
import os
import plistlib
import re
import stat
import struct

from inventory_qa_zip import CHUNK, MIB, QA_ROOT, InventoryError, remaining, require

MAX_PLIST = MIB
MAX_HEADER = 16 * MIB
MAX_PACKAGE = MIB
MAX_SAFE = (1 << 53) - 1
IDENTITY_ERRORS = frozenset("""IDENTITY_FILE IDENTITY_EXECUTABLE IDENTITY_PLIST_SIZE
IDENTITY_PLIST_INVALID IDENTITY_PLIST_DUPLICATE IDENTITY_PLIST_FIELDS IDENTITY_ASAR_RANGE
IDENTITY_ASAR_HEADER IDENTITY_ASAR_ENTRY IDENTITY_ASAR_JSON IDENTITY_PACKAGE_NAME IDENTITY_INVALID""".split())


def same_file(before, after):
    return all(getattr(before, name) == getattr(after, name)
               for name in ("st_dev", "st_ino", "st_mode", "st_uid", "st_nlink", "st_size"))


def directory(path, parent=None):
    before = os.stat(path, dir_fd=parent, follow_symlinks=False)
    require(stat.S_ISDIR(before.st_mode) and before.st_uid == os.getuid(), "IDENTITY_FILE")
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    try:
        require(same_file(before, os.fstat(fd)), "IDENTITY_FILE")
        return fd
    except BaseException:
        os.close(fd)
        raise


@contextlib.contextmanager
def critical_file(stage_fd, parts):
    with contextlib.ExitStack() as opened:
        parent = stage_fd
        for part in (QA_ROOT, "Contents", *parts[:-1]):
            parent = directory(part, parent)
            opened.callback(os.close, parent)
        name = parts[-1]
        before = os.stat(name, dir_fd=parent, follow_symlinks=False)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid()
                and before.st_nlink == 1, "IDENTITY_FILE")
        # Precheck rejects special files; NONBLOCK also prevents a racing FIFO substitution hanging open.
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        opened.callback(os.close, fd)
        after = os.fstat(fd)
        require(same_file(before, after) and stat.S_ISREG(after.st_mode), "IDENTITY_FILE")
        yield fd, after


def read_range(fd, total, offset, size, cap, deadline):
    require(type(size) is int and type(offset) is int and 0 <= size <= cap
            and 0 <= offset <= MAX_SAFE and offset + size <= min(total, MAX_SAFE), "IDENTITY_ASAR_RANGE")
    chunks = []
    count = 0
    while count < size:
        remaining(deadline)
        chunk = os.pread(fd, min(CHUNK, size - count), offset + count)
        require(bool(chunk), "IDENTITY_ASAR_RANGE")
        chunks.append(chunk)
        count += len(chunk)
    return b"".join(chunks)


class UniqueDict(dict):
    def __setitem__(self, key, value):
        require(key not in self, "IDENTITY_PLIST_DUPLICATE")
        super().__setitem__(key, value)


def check_plist(fd, info, deadline):
    require(0 < info.st_size <= MAX_PLIST, "IDENTITY_PLIST_SIZE")
    data = read_range(fd, info.st_size, 0, info.st_size, MAX_PLIST, deadline)
    try:
        value = plistlib.loads(data, dict_type=UniqueDict)
    except InventoryError:
        raise
    except Exception:
        raise InventoryError("IDENTITY_PLIST_INVALID") from None
    require(isinstance(value, dict)
            and type(value.get("CFBundleIdentifier")) is str and value["CFBundleIdentifier"] == "com.mantu.asktoto.qa"
            and type(value.get("CFBundleExecutable")) is str and value["CFBundleExecutable"] == "Metis QA",
            "IDENTITY_PLIST_FIELDS")


def json_value(raw):
    def invalid_constant(value):
        raise InventoryError("IDENTITY_ASAR_JSON")
    try:
        # Default dictionary construction keeps JSON.parse's effective last-key semantics.
        return json.loads(raw.decode("utf-8"), parse_constant=invalid_constant)
    except Exception:
        raise InventoryError("IDENTITY_ASAR_JSON") from None


def packaged_name(fd, info, deadline):
    prefix = read_range(fd, info.st_size, 0, 16, 16, deadline)
    magic, header_size, payload_size, json_size = struct.unpack("<IIII", prefix)
    require(magic == 4 and 8 <= header_size <= MAX_HEADER and payload_size == header_size - 4
            and json_size <= header_size - 8 and 8 + header_size <= info.st_size, "IDENTITY_ASAR_HEADER")
    header = json_value(read_range(fd, info.st_size, 16, json_size, MAX_HEADER, deadline))
    files = header.get("files") if isinstance(header, dict) else None
    entry = files.get("package.json") if isinstance(files, dict) else None
    require(isinstance(entry, dict) and not any(key in entry for key in ("link", "unpacked", "files")),
            "IDENTITY_ASAR_ENTRY")
    size, offset = entry.get("size"), entry.get("offset")
    # JSON 1.0 is an integer-valued Number in the source JS reader, but JSON true is not.
    require(type(size) in (int, float) and 1 <= size <= MAX_PACKAGE
            and int(size) == size and isinstance(offset, str)
            and re.fullmatch(r"0|[1-9][0-9]{0,15}", offset) is not None, "IDENTITY_ASAR_ENTRY")
    offset = int(offset)
    require(offset <= MAX_SAFE, "IDENTITY_ASAR_RANGE")
    package = json_value(read_range(fd, info.st_size, 8 + header_size + offset, int(size), MAX_PACKAGE, deadline))
    require(isinstance(package, dict) and type(package.get("name")) is str
            and package["name"] == "asktoto-qa", "IDENTITY_PACKAGE_NAME")


def verify_qa_identity(stage, deadline):
    """Only the extractor's live stage is accepted by the caller, never a report-selected path."""
    try:
        remaining(deadline)
        with contextlib.ExitStack() as opened:
            stage_fd = directory(stage)
            opened.callback(os.close, stage_fd)
            require(stat.S_IMODE(os.fstat(stage_fd).st_mode) == 0o700, "IDENTITY_FILE")
            with critical_file(stage_fd, ("Info.plist",)) as (fd, info):
                check_plist(fd, info, deadline)
            with critical_file(stage_fd, ("MacOS", "Metis QA")) as (_, info):
                require(info.st_size > 0 and stat.S_IMODE(info.st_mode) == 0o755, "IDENTITY_EXECUTABLE")
            with critical_file(stage_fd, ("Resources", "app.asar")) as (fd, info):
                packaged_name(fd, info, deadline)
        remaining(deadline)
        return {"status": "PASS", "bundleIdentifier": "com.mantu.asktoto.qa", "bundleExecutable": "Metis QA",
                "packageName": "asktoto-qa", "appleParserAgreement": "NOT_RUN", "codeSignature": "NOT_ASSESSED"}
    except InventoryError:
        raise
    except OSError:
        raise InventoryError("IDENTITY_FILE") from None
    except Exception:
        raise InventoryError("IDENTITY_INVALID") from None
