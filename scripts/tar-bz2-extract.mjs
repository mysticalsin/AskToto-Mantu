/**
 * tar-bz2-extract.mjs — in-process, dependency-free .tar.bz2 decompression + extraction, for win32 only.
 *
 * WHY THIS EXISTS (see fetchParakeet() in fetch-models.mjs): extracting a .tar.bz2 by shelling out to
 * `tar xjf <path>` is unreliable on Windows in two distinct, machine-configuration-dependent ways,
 * both confirmed by hand against this file's own decoder during development:
 *
 *   - GNU tar (only reachable when a Git-Bash-flavored PATH is active, e.g. Git Bash itself or a shell
 *     with Git's usr/bin prepended — NOT present on the plain Windows PATH even when Git for Windows is
 *     installed) misparses an absolute Windows path like `C:\Users\...\archive.tar.bz2` as
 *     `[user@]host:path` remote-tape syntax: `tar (child): Cannot connect to C: resolve failed`. Adding
 *     --force-local fixes this specific parse (confirmed), but only for GNU tar.
 *
 *   - bsdtar — the tar.exe built into System32 on Windows 10 1803+/Server 2019+, and the ONLY `tar`
 *     reachable from a plain terminal with no Git-Bash PATH entries, i.e. what a fresh Windows machine
 *     resolves by default — has no bzip2 codec linked in, so it shells out to an external bzip2.exe as
 *     a filter subprocess. Under Node's child_process (execFile/execFileSync), this nested
 *     tar-spawns-bzip2 relationship can deadlock on Windows pipe/handle inheritance: confirmed by hand
 *     that a small single-block archive extracts fine, but a realistic multi-block archive (~40 MB
 *     source, 5 blocks) hangs forever via `execFileAsync('tar', ['xjf', ...])` with zero bytes written —
 *     exactly matching the field report for the real ~487 MB / hundreds-of-blocks Parakeet archive.
 *     --force-local does not help here: it is a GNU tar flag that bsdtar does not need and does not fix
 *     the external-filter deadlock, which is a completely different mechanism from GNU tar's colon
 *     misparse.
 *
 * Rather than pick a specific external tar/bzip2 combination and hope it is on PATH — Git for Windows is
 * not guaranteed on a fresh machine, and even when present its GNU tar is usually not reachable from a
 * plain terminal — this module decompresses bzip2 and unpacks the ustar container entirely in-process,
 * using only Node builtins (fs/crypto-free; no zlib either, since zlib is gzip/deflate only and cannot
 * decode bzip2). No new dependency: there is no pure-JS bzip2 decoder anywhere in node_modules, checked
 * both as a direct and transitive dependency (node-tar is gzip-only; no seek-bzip/unbzip2-stream/etc.
 * present anywhere in the tree) — and package.json is out of scope for this fix regardless.
 *
 * macOS/Linux keep using the system `tar` unchanged (see fetch-models.mjs) — this module is win32-only,
 * and is intentionally never imported from the mac/Linux code path.
 *
 * Implementation notes for future maintainers:
 *   - This decodes the full bzip2 container: canonical Huffman (bzip2's own delta-coded length scheme,
 *     multi-table group switching every 50 symbols), move-to-front + RLE2 symbol decode, inverse
 *     Burrows-Wheeler transform, and the RLE1 pass the encoder applies before the BWT. Each block's
 *     CRC-32/BZIP2 (poly 0x04C11DB7, init/xorout 0xFFFFFFFF, not reflected) is verified as an internal
 *     self-check in addition to the caller's own SHA-256 manifest gate.
 *   - "Randomized" blocks (a deprecated bzip2 feature unused by any encoder in the last two decades) are
 *     detected and rejected with a clear error rather than silently mis-decoded.
 *   - The tar reader supports plain ustar plus the GNU longname ('L') extension; entries are validated
 *     to stay within destDir (defends against a hostile or corrupt archive writing outside the target).
 *   - Both stages were validated during development against real bzip2/tar-produced fixtures (including
 *     a ~40 MB, 5-block archive and a full-size rebuild of the actual ~640 MB Parakeet model directory),
 *     comparing decoded bytes and SHA-256 against the known-good originals byte-for-byte. See
 *     scripts/tar-bz2-extract.test.ts for the small, embedded-fixture regression coverage.
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'

// ─── Bit reader (MSB-first, matching bzip2's bitstream convention) ────────────────────────────────────
class BitReader {
  constructor(buf) {
    this.buf = buf
    this.pos = 0
    this.bitBuf = 0
    this.bitCount = 0
  }

  /** Read n bits (n <= 24) as an unsigned integer, MSB-first. */
  readBits(n) {
    while (this.bitCount < n) {
      if (this.pos >= this.buf.length) throw new Error('bzip2: unexpected end of input while reading bits')
      this.bitBuf = ((this.bitBuf << 8) | this.buf[this.pos++]) >>> 0
      this.bitCount += 8
    }
    this.bitCount -= n
    return (this.bitBuf >>> this.bitCount) & ((1 << n) - 1)
  }

  readBit() {
    return this.readBits(1)
  }

  /** Read a 32-bit unsigned value. Combines two 16-bit reads via multiplication (not a 16-bit shift) so
   *  the result is never subject to JS's 32-bit *signed* bitwise-shift wraparound. */
  readBits32() {
    const hi = this.readBits(16)
    const lo = this.readBits(16)
    return hi * 65536 + lo
  }
}

// ─── CRC-32/BZIP2 (poly 0x04C11DB7, init/xorout 0xFFFFFFFF, NOT reflected) ─────────────────────────────
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let crc = (i << 24) >>> 0
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x80000000) ? (((crc << 1) >>> 0) ^ 0x04c11db7) : (crc << 1) >>> 0
    }
    table[i] = crc >>> 0
  }
  return table
})()

function crc32UpdateByte(crc, byte) {
  return (((crc << 8) >>> 0) ^ CRC_TABLE[(crc >>> 24) ^ byte]) >>> 0
}

// ─── Canonical Huffman table construction + symbol decode (bzip2's own scheme) ────────────────────────
// bzip2 caps encoded code lengths at 20; a couple of bits of headroom keeps this robust to any stream.
const MAX_CODE_LEN = 24

function buildHuffmanTable(lengths, alphaSize) {
  let minLen = 32
  let maxLen = 0
  for (let i = 0; i < alphaSize; i++) {
    if (lengths[i] > maxLen) maxLen = lengths[i]
    if (lengths[i] < minLen) minLen = lengths[i]
  }

  // perm[]: symbol indices ordered by (code length asc, symbol index asc) — canonical Huffman order.
  const perm = new Int32Array(alphaSize)
  let pp = 0
  for (let len = minLen; len <= maxLen; len++) {
    for (let sym = 0; sym < alphaSize; sym++) {
      if (lengths[sym] === len) perm[pp++] = sym
    }
  }

  // base[]/limit[]: standard canonical-Huffman decode tables built via cumulative counts per length.
  const base = new Int32Array(MAX_CODE_LEN + 2)
  for (let i = 0; i < alphaSize; i++) base[lengths[i] + 1]++
  for (let i = 1; i < MAX_CODE_LEN + 2; i++) base[i] += base[i - 1]

  const limit = new Int32Array(MAX_CODE_LEN + 2)
  let vec = 0
  for (let len = minLen; len <= maxLen; len++) {
    vec += base[len + 1] - base[len]
    limit[len] = vec - 1
    vec *= 2
  }
  for (let len = minLen + 1; len <= maxLen; len++) {
    base[len] = (limit[len - 1] + 1) * 2 - base[len]
  }

  return { minLen, maxLen, perm, base, limit }
}

function decodeSymbol(reader, table) {
  let len = table.minLen
  let code = reader.readBits(len)
  while (len > table.maxLen || code > table.limit[len]) {
    if (len > table.maxLen) throw new Error('bzip2: Huffman code exceeds max length (corrupt stream?)')
    len++
    code = code * 2 + reader.readBit()
  }
  return table.perm[code - table.base[len]]
}

// ─── Single bzip2 stream -> decompressed Buffer ────────────────────────────────────────────────────────
export function decompressBzip2(input) {
  if (input.length < 4 || input[0] !== 0x42 || input[1] !== 0x5a || input[2] !== 0x68) {
    throw new Error('bzip2: missing "BZh" header')
  }
  const levelDigit = input[3] - 0x30
  if (levelDigit < 1 || levelDigit > 9) throw new Error('bzip2: invalid block-size digit in header')

  const reader = new BitReader(input)
  reader.pos = 4 // "BZh" + digit already consumed above as whole bytes

  const outChunks = []

  for (;;) {
    const magicHi = reader.readBits(24)
    const magicLo = reader.readBits(24)

    if (magicHi === 0x177245 && magicLo === 0x385090) {
      reader.readBits32() // combined stream CRC — not enforced; each block's own CRC already gates below
      break
    }
    if (!(magicHi === 0x314159 && magicLo === 0x265359)) {
      throw new Error('bzip2: bad block magic (corrupt stream?)')
    }

    const storedBlockCrc = reader.readBits32()
    const randomized = reader.readBit()
    if (randomized !== 0) {
      throw new Error('bzip2: randomized blocks are not supported (deprecated bzip2 feature, unused by any modern encoder)')
    }
    const origPtr = reader.readBits(24)

    // Symbol map: which of the 256 byte values actually appear in this block, as a 16x16 bitmap.
    const used16 = reader.readBits(16)
    const seqToUnseq = []
    for (let i = 0; i < 16; i++) {
      if (used16 & (0x8000 >>> i)) {
        const bits = reader.readBits(16)
        for (let j = 0; j < 16; j++) {
          if (bits & (0x8000 >>> j)) seqToUnseq.push(i * 16 + j)
        }
      }
    }
    const nSymbols = seqToUnseq.length
    if (nSymbols === 0) throw new Error('bzip2: empty symbol map (corrupt stream?)')
    // MTF/RLE2 alphabet: RUNA(0), RUNB(1), one symbol per used byte value's MTF rank 1..nSymbols-1,
    // plus a trailing EOB symbol — nSymbols "rank" slots contributed by seqToUnseq, +1 for EOB, and
    // RUNA/RUNB piggyback on ranks that would otherwise be rank 0 (never encoded directly).
    const alphaSize = nSymbols + 2

    const nGroups = reader.readBits(3)
    if (nGroups < 2 || nGroups > 6) throw new Error(`bzip2: invalid nGroups ${nGroups}`)
    const nSelectors = reader.readBits(15)

    const selectorMtf = new Uint8Array(nSelectors)
    for (let i = 0; i < nSelectors; i++) {
      let j = 0
      while (reader.readBit() === 1) {
        j++
        if (j >= nGroups) throw new Error('bzip2: selector MTF value out of range (corrupt stream?)')
      }
      selectorMtf[i] = j
    }
    // Inverse MTF over the group-index alphabet [0..nGroups-1] to get the real per-50-symbols table index.
    const selectors = new Uint8Array(nSelectors)
    {
      const pos = Array.from({ length: nGroups }, (_, idx) => idx)
      for (let i = 0; i < nSelectors; i++) {
        const j = selectorMtf[i]
        const v = pos[j]
        for (let k = j; k > 0; k--) pos[k] = pos[k - 1]
        pos[0] = v
        selectors[i] = v
      }
    }

    const tables = []
    for (let g = 0; g < nGroups; g++) {
      const lengths = new Uint8Array(alphaSize)
      let curr = reader.readBits(5)
      for (let sym = 0; sym < alphaSize; sym++) {
        for (;;) {
          if (curr < 1 || curr > 20) throw new Error(`bzip2: Huffman code length ${curr} out of range (corrupt stream?)`)
          if (reader.readBit() === 0) break
          if (reader.readBit() === 0) curr++
          else curr--
        }
        lengths[sym] = curr
      }
      tables.push(buildHuffmanTable(lengths, alphaSize))
    }

    // ─── MTF + RLE2 decode -> BWT'd buffer (this block's RLE1-encoded, pre-inverse-BWT bytes) ─────────
    const EOB = alphaSize - 1
    const mtf = seqToUnseq.slice()
    const maxBlockBytes = levelDigit * 100000 + 10 // small safety margin over the nominal per-level cap
    const bwtBuf = new Uint8Array(maxBlockBytes)
    let bwtLen = 0
    const unzftab = new Uint32Array(256)

    let groupNo = -1
    let groupPos = 0
    let currTable = null
    let runLen = 0
    let runBit = 0

    const nextSymbol = () => {
      if (groupPos === 0) {
        groupNo++
        if (groupNo >= nSelectors) throw new Error('bzip2: selector list exhausted before EOB (corrupt stream?)')
        currTable = tables[selectors[groupNo]]
        groupPos = 50
      }
      groupPos--
      return decodeSymbol(reader, currTable)
    }

    for (;;) {
      const sym = nextSymbol()
      if (sym === 0 || sym === 1) {
        // RUNA / RUNB: bijective base-2 run-length of the byte currently at the front of the MTF list.
        runLen += (sym + 1) * (1 << runBit)
        runBit++
        continue
      }
      if (runLen > 0) {
        const b = mtf[0]
        if (bwtLen + runLen > bwtBuf.length) throw new Error('bzip2: block run exceeds declared block size (corrupt stream?)')
        bwtBuf.fill(b, bwtLen, bwtLen + runLen)
        unzftab[b] += runLen
        bwtLen += runLen
        runLen = 0
        runBit = 0
      }
      if (sym === EOB) break
      const idx = sym - 1
      const b = mtf[idx]
      for (let k = idx; k > 0; k--) mtf[k] = mtf[k - 1]
      mtf[0] = b
      if (bwtLen >= bwtBuf.length) throw new Error('bzip2: block exceeds declared block size (corrupt stream?)')
      bwtBuf[bwtLen++] = b
      unzftab[b]++
    }

    // ─── Inverse Burrows-Wheeler transform ────────────────────────────────────────────────────────────
    // Standard counting-sort "next pointer" construction: cftab[v] = count of bytes strictly less than
    // v (i.e. v's first row in the sorted-rotations first column); tt[] then maps a sorted-column (F)
    // position to the row whose last column (L, i.e. bwtBuf) holds that same character occurrence.
    // Reconstruction walks tt[] forward from tt[origPtr], reading bwtBuf at each visited row.
    const cftab = new Uint32Array(257)
    for (let i = 0; i < 256; i++) cftab[i + 1] = cftab[i] + unzftab[i]
    const posTab = cftab.slice(0, 256)
    const tt = new Uint32Array(bwtLen)
    for (let i = 0; i < bwtLen; i++) {
      const ch = bwtBuf[i]
      tt[posTab[ch]] = i
      posTab[ch]++
    }

    const bwtOut = new Uint8Array(bwtLen)
    let row = tt[origPtr]
    for (let i = 0; i < bwtLen; i++) {
      bwtOut[i] = bwtBuf[row]
      row = tt[row]
    }

    // ─── RLE1 decode (reverses the encoder's pre-BWT run-length pass) + block CRC ───────────────────
    // Rule: any run of 4 identical bytes is immediately followed by one count byte (0-255, always
    // present even when 0) giving how many MORE copies follow. Longer runs simply chain multiple such
    // (4-literal + count) units back to back.
    let crc = 0xffffffff
    const decoded = []
    let i = 0
    while (i < bwtOut.length) {
      const b = bwtOut[i]
      let runOfB = 1
      while (i + runOfB < bwtOut.length && runOfB < 4 && bwtOut[i + runOfB] === b) runOfB++
      for (let k = 0; k < runOfB; k++) { decoded.push(b); crc = crc32UpdateByte(crc, b) }
      i += runOfB
      if (runOfB === 4) {
        if (i >= bwtOut.length) throw new Error('bzip2: truncated RLE1 run (missing count byte)')
        const count = bwtOut[i]
        i++
        for (let k = 0; k < count; k++) { decoded.push(b); crc = crc32UpdateByte(crc, b) }
      }
    }
    crc = (crc ^ 0xffffffff) >>> 0
    if (crc !== storedBlockCrc) {
      throw new Error(
        `bzip2: block CRC mismatch (expected ${storedBlockCrc.toString(16)}, got ${crc.toString(16)}) — corrupt stream?`
      )
    }

    outChunks.push(Buffer.from(decoded))
  }

  return Buffer.concat(outChunks)
}

// ─── Minimal USTAR (+ GNU longname) extractor ──────────────────────────────────────────────────────────
function readOctalOrBinary(buf, start, len) {
  if (buf[start] & 0x80) {
    // GNU base-256 extension (top bit of the field's first byte set) for sizes beyond the 8 GB octal
    // ceiling. Not expected for these archives, but cheap to support rather than silently misparse.
    let value = 0
    for (let i = 1; i < len; i++) value = value * 256 + buf[start + i]
    return value
  }
  let str = ''
  for (let i = 0; i < len; i++) {
    const c = buf[start + i]
    if (c === 0 || c === 0x20) continue
    str += String.fromCharCode(c)
  }
  str = str.trim()
  return str.length ? parseInt(str, 8) : 0
}

function readString(buf, start, len) {
  let end = start
  while (end < start + len && buf[end] !== 0) end++
  return buf.toString('utf8', start, end)
}

/** ustar header checksum: sum of all 512 bytes with the checksum field itself treated as spaces. */
function headerChecksumOk(block) {
  let str = ''
  for (let i = 148; i < 156; i++) {
    const c = block[i]
    if (c === 0 || c === 0x20) continue
    str += String.fromCharCode(c)
  }
  const stored = str.length ? parseInt(str, 8) : 0
  let sum = 0
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i]
  return sum === stored
}

function isAllZero(block) {
  for (let i = 0; i < 512; i++) if (block[i] !== 0) return false
  return true
}

/** Extract a decompressed ustar tar Buffer into destDir. Returns the list of extracted file paths. */
export function extractUstarBuffer(buf, destDir) {
  const destRoot = resolve(destDir)
  const extracted = []
  let offset = 0
  let pendingLongName = null

  while (offset + 512 <= buf.length) {
    const block = buf.subarray(offset, offset + 512)
    if (isAllZero(block)) break // end-of-archive marker

    if (!headerChecksumOk(block)) throw new Error(`tar: header checksum mismatch at offset ${offset} (corrupt stream?)`)

    const rawName = readString(block, 0, 100)
    const size = readOctalOrBinary(block, 124, 12)
    const typeflag = String.fromCharCode(block[156] || 0)
    const prefix = readString(block, 345, 155)
    offset += 512

    const paddedLen = Math.ceil(size / 512) * 512
    const data = buf.subarray(offset, offset + size)
    offset += paddedLen

    if (typeflag === 'L') { pendingLongName = data.toString('utf8').replace(/\0+$/, ''); continue }
    if (typeflag === 'K') continue // GNU long linkname — consumed for correct offset bookkeeping, unused

    const name = (pendingLongName || (prefix ? `${prefix}/${rawName}` : rawName)).replace(/\0+$/, '')
    pendingLongName = null
    if (!name) continue

    const outPath = resolve(destRoot, name)
    if (outPath !== destRoot && !outPath.startsWith(destRoot + sep)) {
      throw new Error(`tar: entry "${name}" escapes destination directory (corrupt or malicious archive)`)
    }

    if (typeflag === '5') {
      mkdirSync(outPath, { recursive: true })
    } else if (typeflag === '0' || typeflag === '\0') {
      mkdirSync(dirname(outPath), { recursive: true })
      writeFileSync(outPath, data)
      extracted.push(outPath)
    }
    // Other typeflags (symlinks, hardlinks, devices, fifos) are not expected in this archive; skip.
  }

  return extracted
}

/** Read archivePath, decompress in-process, and extract into destDir. win32-only entry point used by
 *  fetch-models.mjs's fetchParakeet() — see the module docstring above for why. */
export function extractTarBz2Windows(archivePath, destDir) {
  const compressed = readFileSync(archivePath)
  const decompressed = decompressBzip2(compressed)
  return extractUstarBuffer(decompressed, destDir)
}
