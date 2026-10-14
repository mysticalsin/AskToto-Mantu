/** Strict reader for the publisher's normalized ustar + gzip runtime payload format. */
import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { createGunzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { isSafeEntryName, type ArchiveSink } from './archive'
import type { RuntimeExtractedFile } from './runtime-provenance'

const BLOCK = 512
const MAX_FILES = 100_000
const MAX_BYTES = 10_000_000_000

function fileVersion(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':')
}

class ByteReader {
  private readonly iterator: AsyncIterator<Uint8Array>
  private chunk = Buffer.alloc(0)
  private offset = 0
  private ended = false
  constructor(source: AsyncIterable<Uint8Array>) {
    this.iterator = source[Symbol.asyncIterator]()
  }

  async read(length: number): Promise<Buffer> {
    if (!Number.isSafeInteger(length) || length < 0 || length > BLOCK) throw new Error('RUNTIME_TAR_INVALID')
    const out = Buffer.alloc(length)
    let written = 0
    while (written < length) {
      if (this.offset >= this.chunk.length) {
        const next = await this.iterator.next()
        if (next.done) {
          this.ended = true
          break
        }
        this.chunk = Buffer.from(next.value)
        this.offset = 0
      }
      const amount = Math.min(length - written, this.chunk.length - this.offset)
      this.chunk.copy(out, written, this.offset, this.offset + amount)
      this.offset += amount
      written += amount
    }
    if (written !== length) throw new Error('RUNTIME_TAR_TRUNCATED')
    return out
  }

  async *take(length: number): AsyncGenerator<Uint8Array> {
    let remaining = length
    while (remaining > 0) {
      if (this.offset >= this.chunk.length) {
        const next = await this.iterator.next()
        if (next.done) {
          this.ended = true
          throw new Error('RUNTIME_TAR_TRUNCATED')
        }
        this.chunk = Buffer.from(next.value)
        this.offset = 0
      }
      const amount = Math.min(remaining, this.chunk.length - this.offset)
      yield this.chunk.subarray(this.offset, this.offset + amount)
      this.offset += amount
      remaining -= amount
    }
  }

  async eof(): Promise<boolean> {
    if (this.offset < this.chunk.length) return false
    if (this.ended) return true
    const next = await this.iterator.next()
    if (next.done) {
      this.ended = true
      return true
    }
    this.chunk = Buffer.from(next.value)
    this.offset = 0
    return false
  }
}

function nulTerminated(header: Buffer, start: number, length: number): string {
  const raw = header.subarray(start, start + length)
  const end = raw.indexOf(0)
  const bytes = end < 0 ? raw : raw.subarray(0, end)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('RUNTIME_TAR_INVALID')
  }
}

function octal(header: Buffer, start: number, length: number): number {
  const raw = header
    .subarray(start, start + length)
    .toString('ascii')
    .replace(/[\0 ]+$/g, '')
    .replace(/^ +/g, '')
  if (!/^[0-7]+$/.test(raw)) throw new Error('RUNTIME_TAR_INVALID')
  const result = Number.parseInt(raw, 8)
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('RUNTIME_TAR_INVALID')
  return result
}

function verifyHeader(header: Buffer): { path: string; size: number; executable: boolean } {
  if (header.length !== BLOCK || header.every((byte) => byte === 0)) throw new Error('RUNTIME_TAR_INVALID')
  const expected = octal(header, 148, 8)
  let actual = 0
  for (let i = 0; i < BLOCK; i++) actual += i >= 148 && i < 156 ? 0x20 : header[i]
  if (
    actual !== expected ||
    header[156] !== 0x30 ||
    nulTerminated(header, 257, 6) !== 'ustar' ||
    nulTerminated(header, 263, 2) !== '00' ||
    nulTerminated(header, 157, 100) !== ''
  ) {
    throw new Error('RUNTIME_TAR_INVALID')
  }
  const name = nulTerminated(header, 0, 100)
  const prefix = nulTerminated(header, 345, 155)
  const path = prefix ? `${prefix}/${name}` : name
  const size = octal(header, 124, 12)
  const mode = octal(header, 100, 8)
  if (
    !isSafeEntryName(path) ||
    (mode !== 0o644 && mode !== 0o755) ||
    octal(header, 108, 8) !== 0 ||
    octal(header, 116, 8) !== 0 ||
    octal(header, 136, 12) !== 0 ||
    header.subarray(265, 345).some((byte) => byte !== 0)
  ) {
    throw new Error('RUNTIME_TAR_INVALID')
  }
  return { path, size, executable: mode === 0o755 }
}

/** Only regular ustar members emitted by create-payload.mjs are accepted; all links/PAX/types fail closed. */
export async function extractRuntimeTarGzip(
  archivePath: string,
  sink: ArchiveSink,
  signal: AbortSignal
): Promise<readonly RuntimeExtractedFile[]> {
  const noFollow = constants.O_NOFOLLOW ?? 0
  const nonBlock = constants.O_NONBLOCK ?? 0
  if (process.platform !== 'win32' && (!noFollow || !nonBlock)) {
    throw new Error('RUNTIME_ARCHIVE_SAFE_OPEN_UNAVAILABLE')
  }
  const archive = await open(archivePath, constants.O_RDONLY | noFollow | nonBlock)
  let opened: BigIntStats
  let pathBefore: BigIntStats
  try {
    opened = await archive.stat({ bigint: true })
    pathBefore = await lstat(archivePath, { bigint: true })
  } catch (error) {
    await archive.close().catch(() => undefined)
    throw error
  }
  if (
    !opened.isFile() ||
    opened.nlink !== 1n ||
    opened.size < 1n ||
    opened.size > BigInt(MAX_BYTES) ||
    !pathBefore.isFile() ||
    pathBefore.nlink !== 1n ||
    fileVersion(pathBefore) !== fileVersion(opened)
  ) {
    await archive.close()
    throw new Error('RUNTIME_ARCHIVE_SHAPE_MISMATCH')
  }
  const gunzip = createGunzip()
  const stream = pipeline(archive.createReadStream({ autoClose: false }), gunzip, { signal })
  const reader = new ByteReader(gunzip)
  let files = 0
  let expanded = 0
  let ended = false
  const records: RuntimeExtractedFile[] = []
  try {
    while (!ended) {
      if (signal.aborted) throw signal.reason ?? new Error('RUNTIME_INSTALL_CANCELLED')
      const header = await reader.read(BLOCK)
      if (header.every((byte) => byte === 0)) {
        const second = await reader.read(BLOCK)
        if (!second.every((byte) => byte === 0) || !(await reader.eof())) throw new Error('RUNTIME_TAR_INVALID')
        ended = true
        break
      }
      const entry = verifyHeader(header)
      if (++files > MAX_FILES || entry.size > MAX_BYTES - expanded) throw new Error('RUNTIME_TAR_LIMIT_EXCEEDED')
      expanded += entry.size
      const digest = createHash('sha256')
      let written = 0
      async function* tracked(): AsyncGenerator<Uint8Array> {
        for await (const chunk of reader.take(entry.size)) {
          written += chunk.byteLength
          digest.update(chunk)
          yield chunk
        }
      }
      await sink.addFile(entry.path, tracked())
      if (written !== entry.size) throw new Error('RUNTIME_TAR_TRUNCATED')
      records.push({ path: entry.path, bytes: written, sha256: digest.digest('hex'), executable: entry.executable })
      const padding = (BLOCK - (entry.size % BLOCK)) % BLOCK
      if (padding && !(await reader.read(padding).then((bytes) => bytes.every((byte) => byte === 0)))) {
        throw new Error('RUNTIME_TAR_INVALID')
      }
    }
    if (!ended) throw new Error('RUNTIME_TAR_INVALID')
    await stream
    const after = await archive.stat({ bigint: true })
    const pathAfter = await lstat(archivePath, { bigint: true })
    if (
      fileVersion(after) !== fileVersion(opened) ||
      !pathAfter.isFile() ||
      pathAfter.nlink !== 1n ||
      fileVersion(pathAfter) !== fileVersion(opened)
    ) {
      throw new Error('RUNTIME_ARCHIVE_CHANGED_DURING_EXTRACT')
    }
    return Object.freeze(records)
  } catch (error) {
    gunzip.destroy(error instanceof Error ? error : new Error('RUNTIME_TAR_INVALID'))
    await stream.catch(() => undefined)
    throw error
  } finally {
    await archive.close().catch(() => undefined)
  }
}
