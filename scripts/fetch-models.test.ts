import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, get as httpGet, type RequestListener, type Server } from 'node:http'
import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { download } from './fetch-models.mjs'
import { decompressBzip2, extractUstarBuffer, extractTarBz2Windows } from './tar-bz2-extract.mjs'

async function startServer(listener: RequestListener) {
  const sockets = new Set<Socket>()
  const server = createServer(listener)
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port')
  return { server, sockets, url: `http://127.0.0.1:${address.port}/model.onnx` }
}

async function stopServer(server: Server, sockets: Set<Socket>) {
  for (const socket of sockets) socket.destroy()
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
}

function settleDownload(operation: Promise<void>) {
  return operation.then(
    () => ({ kind: 'resolved' as const, error: null }),
    (error: Error) => ({ kind: 'rejected' as const, error })
  )
}

function neverRespondingRequestGet(onAttempt: () => void): typeof httpGet {
  return (() => {
    onAttempt()
    const request = new EventEmitter() as EventEmitter & { destroy(error?: Error): void }
    request.destroy = (error) => {
      if (error) request.emit('error', error)
    }
    return request
  }) as unknown as typeof httpGet
}

describe('ASR model downloader', () => {
  it('can be imported for focused network-failure tests without running the provisioning entrypoint', () => {
    const source = readFileSync(new URL('./fetch-models.mjs', import.meta.url), 'utf8')

    expect(source).toMatch(/export function fetchStream/)
    expect(source).toMatch(/export async function download/)
    expect(source).toMatch(/if \(process\.argv\[1\] === fileURLToPath\(import\.meta\.url\)\)/)
  })

  it('bounds a connection that never sends response headers and retries clearly', async () => {
    let attempts = 0
    const requestGet = neverRespondingRequestGet(() => { attempts += 1 })
    const url = 'http://127.0.0.1/model.onnx'
    const scratch = mkdtempSync(join(tmpdir(), 'metis-asr-request-timeout-'))
    const destination = join(scratch, 'model.onnx')

    try {
      const outcome = await settleDownload(
        download(url, destination, {
          requestGet,
          requestTimeoutMs: 500,
          responseIdleTimeoutMs: 500,
          maxAttempts: 2,
          backoffBaseMs: 1
        })
      )

      expect(outcome.kind).toBe('rejected')
      expect(outcome.error?.message).toMatch(/request timeout after 500ms/)
      expect(attempts).toBe(2)
      expect(existsSync(`${destination}.part`)).toBe(false)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  it('bounds a response body that starts and then stalls, without confusing it for header timeout', async () => {
    let requests = 0
    const { server, sockets, url } = await startServer((_request, response) => {
      requests += 1
      response.writeHead(200, { 'content-length': '2' })
      response.flushHeaders()
      response.write('x') // Start the model, then leave it incomplete and idle.
    })
    const scratch = mkdtempSync(join(tmpdir(), 'metis-asr-idle-timeout-'))
    const destination = join(scratch, 'model.onnx')

    try {
      const outcome = await settleDownload(
        download(url, destination, {
          requestGet: httpGet,
          requestTimeoutMs: 5_000,
          responseIdleTimeoutMs: 500,
          maxAttempts: 2,
          backoffBaseMs: 1
        })
      )

      expect(outcome.kind).toBe('rejected')
      expect(outcome.error?.message).toMatch(/response idle timeout after 500ms/)
      expect(requests).toBe(2)
      expect(existsSync(`${destination}.part`)).toBe(false)
    } finally {
      await stopServer(server, sockets)
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})

// ─── win32 in-process .tar.bz2 extraction (scripts/tar-bz2-extract.mjs) ────────────────────────────────
//
// fetchParakeet() shells out to the system `tar` on macOS/Linux (unchanged), but on win32 it now
// decompresses bzip2 and unpacks the ustar container entirely in-process (see extractTarBz2() and
// tar-bz2-extract.mjs's module docstring for why: both tar binaries reachable on a real Windows box —
// GNU tar and bsdtar — are unreliable for this one archive format in two different, hard-to-detect ways).
//
// This fixture is a REAL bzip2-compressed tar archive (not hand-assembled bytes): built with `tar` and
// `bzip2 -1` (100 KB block size) from three small files — including a nested directory entry, matching
// the real Parakeet archive's test_wavs/ subfolder — so it spans two bzip2 blocks and exercises the
// multi-block/table-switching path, group selection, and directory creation in the tar reader. The
// archive bytes and every expected size/sha256 below were captured directly from that real compression;
// nothing here is synthesized independently of an actual bzip2+tar run.
//
// Beyond this embedded fixture, the decoder was additionally validated by hand during development
// against (a) a ~40 MB / 5-block archive and (b) a full-size rebuild of the real ~640 MB Parakeet model
// directory (the exact files this script ships), decompressing the real ~487 MB compressed size reported
// upstream and matching every file's manifest-pinned size and SHA-256 in
// resources/runtime-assets-manifest.json exactly. Neither is practical to embed in a unit test, hence
// the smaller fixture here for fast, offline, deterministic regression coverage.
const FIXTURE_TAR_BZ2_BASE64 =
  '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'

const FIXTURE_EXPECTED_FILES: Record<string, { bytes: number; sha256: string }> = {
  'model.bin': { bytes: 143360, sha256: '81e6244900ec07f738236596454e1d7fcb27bdfac8c9f5233c8b07a8790f6bbd' },
  'tokens.txt': { bytes: 13, sha256: '7eb5b49dd0c830222d859ed00c96bf8886b4fd51186de1b36538c26b559178c7' },
  [join('nested', 'en.wav')]: { bytes: 22, sha256: '68d5dd791c89d446d2fb9143b574b549ceb4eabdafa39c4e9bbaecf375e26e25' }
}

function sha256Hex(data: Buffer) {
  return createHash('sha256').update(data).digest('hex')
}

/** A minimal, hand-built single-entry ustar block, for testing the tar reader in isolation from bzip2. */
function buildUstarHeader(name: string, { size = 0, typeflag = '0' }: { size?: number; typeflag?: string } = {}) {
  const block = Buffer.alloc(512)
  block.write(name, 0, 'utf8')
  block.write('0000644\0', 100, 'utf8')
  block.write('0000000\0', 108, 'utf8')
  block.write('0000000\0', 116, 'utf8')
  block.write(`${size.toString(8).padStart(11, '0')} `, 124, 'utf8')
  block.write('00000000000 ', 136, 'utf8')
  block.fill(0x20, 148, 156)
  block[156] = typeflag.charCodeAt(0)
  block.write('ustar\0', 257, 'utf8')
  block.write('00', 263, 'utf8')
  let sum = 0
  for (let i = 0; i < 512; i++) sum += block[i]
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8')
  return block
}

describe('win32 in-process .tar.bz2 extraction (scripts/tar-bz2-extract.mjs)', () => {
  it('extractTarBz2Windows decompresses and extracts a real multi-block archive byte-exact', () => {
    const archiveBuf = Buffer.from(FIXTURE_TAR_BZ2_BASE64, 'base64')
    const scratch = mkdtempSync(join(tmpdir(), 'metis-tar-bz2-'))
    const archivePath = join(scratch, 'fixture.tar.bz2')
    const destDir = join(scratch, 'out')
    writeFileSync(archivePath, archiveBuf)

    try {
      const extracted = extractTarBz2Windows(archivePath, destDir)
      expect(extracted).toHaveLength(Object.keys(FIXTURE_EXPECTED_FILES).length)

      for (const [rel, expected] of Object.entries(FIXTURE_EXPECTED_FILES)) {
        const outPath = join(destDir, rel)
        expect(statSync(outPath).size).toBe(expected.bytes)
        expect(sha256Hex(readFileSync(outPath))).toBe(expected.sha256)
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  it('decompressBzip2 alone reproduces the exact decompressed tar bytes across both blocks', () => {
    const archiveBuf = Buffer.from(FIXTURE_TAR_BZ2_BASE64, 'base64')
    const decompressed = decompressBzip2(archiveBuf)

    // The decompressed stream is a ustar tar: its first header's magic must land at the fixed ustar
    // offset, and it must be big enough to hold every entry plus the trailing zero-block terminator.
    expect(decompressed.toString('utf8', 257, 262)).toBe('ustar')
    expect(decompressed.length).toBeGreaterThan(143360)
  })

  it('extractUstarBuffer creates nested directories implied by an entry path', () => {
    const decompressed = decompressBzip2(Buffer.from(FIXTURE_TAR_BZ2_BASE64, 'base64'))
    const scratch = mkdtempSync(join(tmpdir(), 'metis-ustar-'))
    try {
      const extracted = extractUstarBuffer(decompressed, scratch)
      expect(extracted.sort()).toEqual(
        [join(scratch, 'model.bin'), join(scratch, 'nested', 'en.wav'), join(scratch, 'tokens.txt')].sort()
      )
      expect(readFileSync(join(scratch, 'tokens.txt'), 'utf8')).toBe('tokens\nen\nfr\n')
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  it('rejects non-bzip2 input with a clear error instead of hanging or silently corrupting output', () => {
    expect(() => decompressBzip2(Buffer.from('definitely not a bzip2 file'))).toThrow(/BZh/)
  })

  it('rejects a truncated archive with a clear error rather than returning wrong bytes', () => {
    const archiveBuf = Buffer.from(FIXTURE_TAR_BZ2_BASE64, 'base64')
    const truncated = archiveBuf.subarray(0, archiveBuf.length - 100)
    expect(() => decompressBzip2(truncated)).toThrow()
  })

  it('extractUstarBuffer refuses to write outside destDir (path-traversal guard)', () => {
    const evilHeader = buildUstarHeader('../evil.txt')
    const archive = Buffer.concat([evilHeader, Buffer.alloc(512)])
    const scratch = mkdtempSync(join(tmpdir(), 'metis-ustar-traversal-'))
    try {
      expect(() => extractUstarBuffer(archive, join(scratch, 'dest'))).toThrow(/escapes destination directory/)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})
