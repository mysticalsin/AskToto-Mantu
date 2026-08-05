/**
 * zip-extract.mjs — in-process, dependency-free .zip extraction. Sibling of tar-bz2-extract.mjs, and it
 * exists for the same reason: on Windows there is no such thing as a predictable external `tar`.
 *
 * WHY THIS EXISTS (see extractArchive() in fetch-llama-server.mjs): Node resolves a BARE command name on
 * Windows through PATH only — libuv's spawn does NOT fall back to System32 the way a raw CreateProcess
 * would (confirmed by hand: with PATH emptied, `execFileSync('tar', …)` fails ENOENT). So `tar` means
 * whichever of the two tars the invoking shell happens to reach first:
 *
 *   - bsdtar 3.x at %SystemRoot%\System32\tar.exe — shipped with Windows 10 1803+/Server 2019+, reads
 *     .zip and .tar.gz natively, and is what a plain terminal resolves.
 *   - GNU tar 1.35 at C:\Program Files\Git\usr\bin\tar.exe — reached from Git Bash or any shell with
 *     Git's usr/bin prepended. It cannot read a .zip container at all, and it parses the leading `D:` of
 *     an absolute Windows archive path as `[user@]host:path` remote-tape syntax. Confirmed by hand
 *     against the real llama asset: `tar: Cannot connect to D: resolve failed`.
 *
 * That makes packaging a coin flip decided by the operator's PATH order, not by anything in the repo.
 * Inflating the zip in-process removes the external binary — and therefore PATH — from the decision
 * entirely. Only Node builtins are used (zlib covers raw deflate, which is all a .zip needs); nothing is
 * added to package.json.
 *
 * macOS/Linux keep using the system `tar` unchanged — this module is only wired into the win32 branch.
 *
 * Implementation notes for future maintainers:
 *   - Reads the CENTRAL DIRECTORY (not a forward scan of local headers) so entries written with a
 *     streaming data descriptor — whose local-header sizes are zeroed — still carry correct sizes.
 *   - ZIP64 is supported (locator + EOCD record, and the 0x0001 extra field for per-entry sizes/offset),
 *     so this does not silently mis-read the day an upstream release crosses the 4 GB / 65535-entry line.
 *   - Every entry's CRC-32 is verified against the central directory as an internal self-check, in
 *     addition to the caller's own SHA-256 archive gate.
 *   - Entries are validated to stay within destDir (defends against a hostile or corrupt archive writing
 *     outside the target), matching extractUstarBuffer's guard in tar-bz2-extract.mjs.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'

const SIG_EOCD = 0x06054b50
const SIG_ZIP64_LOCATOR = 0x07064b50
const SIG_ZIP64_EOCD = 0x06064b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50

const METHOD_STORE = 0
const METHOD_DEFLATE = 8

// A zip comment is a 16-bit length, so the EOCD record starts at most 22 + 65535 bytes from the end.
const MAX_EOCD_SEARCH = 22 + 0xffff

// ─── CRC-32 (reflected, poly 0xEDB88320 — the zip/gzip variant, NOT bzip2's) ──────────────────────────
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let crc = i
    for (let j = 0; j < 8; j++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    table[i] = crc >>> 0
  }
  return table
})()

function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff]
  return (crc ^ 0xffffffff) >>> 0
}

/** Read a 64-bit little-endian size/offset as a Number, refusing anything past exact-integer range
 *  rather than silently truncating it into a wrong file offset. */
function readU64(buf, offset) {
  const value = buf.readBigUInt64LE(offset)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('zip: 64-bit field exceeds Number.MAX_SAFE_INTEGER')
  return Number(value)
}

/** Locate the End Of Central Directory record and return the central directory's offset + entry count,
 *  transparently upgrading to the ZIP64 records when the classic fields are saturated. */
function readEndOfCentralDirectory(buf) {
  const from = Math.max(0, buf.length - MAX_EOCD_SEARCH)
  let eocd = -1
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('zip: end-of-central-directory record not found (not a zip, or truncated?)')

  let entries = buf.readUInt16LE(eocd + 10)
  let centralOffset = buf.readUInt32LE(eocd + 16)

  const locator = eocd - 20
  if (locator >= 0 && buf.readUInt32LE(locator) === SIG_ZIP64_LOCATOR) {
    const zip64Eocd = readU64(buf, locator + 8)
    if (buf.readUInt32LE(zip64Eocd) !== SIG_ZIP64_EOCD) throw new Error('zip: bad ZIP64 end-of-central-directory signature')
    entries = readU64(buf, zip64Eocd + 32)
    centralOffset = readU64(buf, zip64Eocd + 48)
  }

  return { entries, centralOffset }
}

/** Pull the ZIP64 extended-information extra field's replacements for whichever of uncompressed size,
 *  compressed size and local-header offset were written saturated (0xFFFFFFFF) in the fixed fields.
 *  The field packs only the saturated members, in that fixed order. */
function applyZip64Extra(extra, sizes) {
  let offset = 0
  while (offset + 4 <= extra.length) {
    const headerId = extra.readUInt16LE(offset)
    const dataSize = extra.readUInt16LE(offset + 2)
    if (headerId === 0x0001) {
      let cursor = offset + 4
      if (sizes.uncompressedSize === 0xffffffff) { sizes.uncompressedSize = readU64(extra, cursor); cursor += 8 }
      if (sizes.compressedSize === 0xffffffff) { sizes.compressedSize = readU64(extra, cursor); cursor += 8 }
      if (sizes.localHeaderOffset === 0xffffffff) { sizes.localHeaderOffset = readU64(extra, cursor); cursor += 8 }
      return
    }
    offset += 4 + dataSize
  }
}

/** Extract a zip held entirely in memory into destDir. Returns the list of extracted file paths. */
export function extractZipBuffer(buf, destDir) {
  const destRoot = resolve(destDir)
  const { entries, centralOffset } = readEndOfCentralDirectory(buf)
  const extracted = []
  let offset = centralOffset

  for (let i = 0; i < entries; i++) {
    if (buf.readUInt32LE(offset) !== SIG_CENTRAL) throw new Error(`zip: bad central-directory signature for entry ${i}`)
    const flags = buf.readUInt16LE(offset + 8)
    const method = buf.readUInt16LE(offset + 10)
    const expectedCrc = buf.readUInt32LE(offset + 16)
    const nameLen = buf.readUInt16LE(offset + 28)
    const extraLen = buf.readUInt16LE(offset + 30)
    const commentLen = buf.readUInt16LE(offset + 32)
    const sizes = {
      compressedSize: buf.readUInt32LE(offset + 20),
      uncompressedSize: buf.readUInt32LE(offset + 24),
      localHeaderOffset: buf.readUInt32LE(offset + 42)
    }
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen)
    applyZip64Extra(buf.subarray(offset + 46 + nameLen, offset + 46 + nameLen + extraLen), sizes)
    offset += 46 + nameLen + extraLen + commentLen

    // Bit 0 is the legacy PKWARE encryption flag; there is no key to try, so fail loudly instead of
    // writing ciphertext to disk and failing much later as a mysterious "bad binary".
    if (flags & 0x1) throw new Error(`zip: entry "${name}" is encrypted, which is not supported`)
    if (!name) continue

    const outPath = resolve(destRoot, name)
    if (outPath !== destRoot && !outPath.startsWith(destRoot + sep)) {
      throw new Error(`zip: entry "${name}" escapes destination directory (corrupt or malicious archive)`)
    }

    if (name.endsWith('/')) {
      mkdirSync(outPath, { recursive: true })
      continue
    }

    // The local header repeats the name and carries its OWN extra field, whose length routinely differs
    // from the central directory's — the payload starts after the local copy, never the central one.
    const local = sizes.localHeaderOffset
    if (buf.readUInt32LE(local) !== SIG_LOCAL) throw new Error(`zip: bad local-header signature for entry "${name}"`)
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const raw = buf.subarray(dataStart, dataStart + sizes.compressedSize)

    let data
    if (method === METHOD_STORE) data = Buffer.from(raw)
    else if (method === METHOD_DEFLATE) data = inflateRawSync(raw)
    else throw new Error(`zip: entry "${name}" uses unsupported compression method ${method}`)

    if (data.length !== sizes.uncompressedSize) {
      throw new Error(`zip: entry "${name}" inflated to ${data.length} bytes, expected ${sizes.uncompressedSize}`)
    }
    const actualCrc = crc32(data)
    if (actualCrc !== expectedCrc) {
      throw new Error(
        `zip: entry "${name}" CRC mismatch (expected ${expectedCrc.toString(16)}, got ${actualCrc.toString(16)}) — corrupt archive?`
      )
    }

    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, data)
    extracted.push(outPath)
  }

  return extracted
}

/** Read archivePath and extract it into destDir, entirely in-process. Used by fetch-llama-server.mjs on
 *  win32 — see the module docstring above for why no external tool is involved. */
export function extractZip(archivePath, destDir) {
  return extractZipBuffer(readFileSync(archivePath), destDir)
}
