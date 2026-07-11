/**
 * local-models.test.ts — proves the manifest pin law, streamed-checksum rejection, RAM gating, Range
 * resume, and the renderer-safe metadata shape, against a REAL local HTTP server (not the real Hugging
 * Face URLs baked into LOCAL_MODELS — those are never touched in tests).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import { app } from 'electron'

vi.mock('electron')

// Mutable, hoisted so the vi.mock('node:os', ...) factory below (hoisted above imports by Vitest) can
// close over it safely. Defaults high so unrelated tests never trip the RAM gate by accident.
const ramState = vi.hoisted(() => ({ totalMemBytes: 64 * 1024 ** 3 }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, totalmem: () => ramState.totalMemBytes }
})

import {
  LOCAL_MODELS,
  downloadModel,
  downloadModelFile,
  isDownloaded,
  modelPaths,
  deleteModel,
  listModels,
  cancelDownload,
  assertRamOk,
  InsufficientRamError,
  ChecksumMismatchError,
  type LocalModelFile
} from './local-models'

const mockAppGetPath = app.getPath as ReturnType<typeof vi.fn>

function setTotalMemGB(gb: number): void {
  ramState.totalMemBytes = gb * 1024 ** 3
}

/** Real local HTTP server (127.0.0.1, ephemeral port) — mirrors the pattern in bidstackClient.test.ts.
 *  downloadModelFile dispatches to node:http for a plain "http:" URL, so this exercises the exact same
 *  streaming/resume/hash code path production uses against huggingface.co, without any network access. */
async function startMockServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
  }
}

describe('local-models', () => {
  let userData: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'asktoto-local-models-test-'))
    mockAppGetPath.mockImplementation((name: string) => (name === 'userData' ? userData : join(userData, name)))
    setTotalMemGB(64)
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  // ─── Manifest law: only a real-download-verified sha256 may ship ───────────────────────────────
  describe('manifest shape / pin enforcement', () => {
    it('ships EXACTLY the two fully-pinned v1 models', () => {
      expect(LOCAL_MODELS.map((m) => m.id)).toEqual(['qwen3.5-0.8b', 'qwen3.5-2b'])
    })

    it('every entry carries a 64-hex sha256 for BOTH gguf and mmproj, positive bytes, and an https huggingface.co URL', () => {
      const hex64 = /^[0-9a-f]{64}$/
      for (const m of LOCAL_MODELS) {
        for (const part of [m.gguf, m.mmproj] as const) {
          expect(part.sha256).toMatch(hex64)
          expect(part.bytes).toBeGreaterThan(0)
          expect(part.url).toMatch(/^https:\/\/huggingface\.co\//)
        }
        expect(m.minTotalRamGB).toBeGreaterThan(0)
        expect(m.label.length).toBeGreaterThan(0)
      }
    })

    it('pins the exact byte sizes and hashes from the plan (regression guard against silent drift)', () => {
      const lite = LOCAL_MODELS.find((m) => m.id === 'qwen3.5-0.8b')!
      expect(lite.gguf.bytes).toBe(558772480)
      expect(lite.gguf.sha256).toBe('3177ebd67afe4438374da19e690bc1b98756f7e0fea9240e1be404336156a7b5')
      expect(lite.mmproj.bytes).toBe(204987232)
      expect(lite.mmproj.sha256).toBe('56e4c6cfe73b0c82e3e82bc518d7591997e61d81f723fc41a586f4fa69ea2453')

      const dflt = LOCAL_MODELS.find((m) => m.id === 'qwen3.5-2b')!
      expect(dflt.gguf.bytes).toBe(1339752704)
      expect(dflt.gguf.sha256).toBe('0af96165ea615bea39a04118d63f0b6d35908aea850ee4a51aa6151d851b8b35')
      expect(dflt.mmproj.bytes).toBe(668227264)
      expect(dflt.mmproj.sha256).toBe('7035e9cb8d7c6a9681d07eef9a364783e86ea4cd73faab2eabb4f43a101830c7')
    })
  })

  // ─── RAM gate ────────────────────────────────────────────────────────────────────────────────
  describe('RAM gate', () => {
    it('refuses when total RAM is below minTotalRamGB, naming a smaller model in the message', () => {
      setTotalMemGB(2)
      let thrown: unknown
      try {
        assertRamOk('qwen3.5-2b')
      } catch (e) {
        thrown = e
      }
      expect(thrown).toBeInstanceOf(InsufficientRamError)
      const err = thrown as InsufficientRamError
      expect(err.modelId).toBe('qwen3.5-2b')
      expect(err.requiredGB).toBe(8)
      expect(err.availableGB).toBeCloseTo(2, 1)
      expect(err.suggestion?.id).toBe('qwen3.5-0.8b')
      expect(err.message).toContain('Qwen3.5 0.8B — Lite')
    })

    it('allows when total RAM meets minTotalRamGB', () => {
      setTotalMemGB(16)
      expect(() => assertRamOk('qwen3.5-2b')).not.toThrow()
    })

    it('downloadModel rejects on the RAM gate before making any network call', async () => {
      setTotalMemGB(1)
      await expect(downloadModel('qwen3.5-2b')).rejects.toBeInstanceOf(InsufficientRamError)
    })
  })

  // ─── Checksum reject ─────────────────────────────────────────────────────────────────────────
  describe('checksum rejection', () => {
    it('deletes the file and throws a typed error on a hash mismatch', async () => {
      const content = Buffer.from('this is not the model you are looking for')
      const mock = await startMockServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(content.length) })
        res.end(content)
      })
      try {
        const spec: LocalModelFile = {
          url: `${mock.url}/bad.gguf`,
          bytes: content.length, // byte count is correct — only the hash is wrong
          sha256: '0'.repeat(64)
        }
        const dest = modelPaths('qwen3.5-0.8b').gguf
        await expect(
          downloadModelFile('qwen3.5-0.8b', 'gguf', spec, new AbortController().signal)
        ).rejects.toBeInstanceOf(ChecksumMismatchError)
        expect(existsSync(dest)).toBe(false)
        expect(existsSync(`${dest}.part`)).toBe(false)
      } finally {
        await mock.close()
      }
    })
  })

  // ─── Range resume ────────────────────────────────────────────────────────────────────────────
  describe('resume', () => {
    it('resumes via a Range request when a partial .part file is present, and produces the correct final file', async () => {
      const full = Buffer.alloc(5000)
      for (let i = 0; i < full.length; i++) full[i] = i % 256
      const sha256 = createHash('sha256').update(full).digest('hex')
      const RESUME_FROM = 2000

      let seenRange: string | undefined
      const mock = await startMockServer((req, res) => {
        const range = req.headers['range']
        seenRange = typeof range === 'string' ? range : undefined
        if (seenRange) {
          const m = /^bytes=(\d+)-$/.exec(seenRange)
          const start = m ? Number(m[1]) : 0
          const chunk = full.subarray(start)
          res.writeHead(206, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(chunk.length),
            'Content-Range': `bytes ${start}-${full.length - 1}/${full.length}`
          })
          res.end(chunk)
        } else {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(full.length) })
          res.end(full)
        }
      })
      try {
        const spec: LocalModelFile = { url: `${mock.url}/resume.gguf`, bytes: full.length, sha256 }
        const dest = modelPaths('qwen3.5-0.8b').gguf
        mkdirSync(dirname(dest), { recursive: true })
        writeFileSync(`${dest}.part`, full.subarray(0, RESUME_FROM))

        const progress: { received: number; total: number }[] = []
        await downloadModelFile('qwen3.5-0.8b', 'gguf', spec, new AbortController().signal, (p) =>
          progress.push({ received: p.received, total: p.total })
        )

        expect(seenRange).toBe(`bytes=${RESUME_FROM}-`)
        expect(existsSync(`${dest}.part`)).toBe(false)
        expect(statSync(dest).size).toBe(full.length)
        expect(readFileSync(dest).equals(full)).toBe(true)
        expect(progress.length).toBeGreaterThan(0)
        expect(progress.every((p) => p.received >= RESUME_FROM)).toBe(true)
        expect(progress.at(-1)).toEqual({ received: full.length, total: full.length })
      } finally {
        await mock.close()
      }
    })

    it('falls back to a clean re-download when the server ignores the Range header', async () => {
      const full = Buffer.alloc(3000)
      for (let i = 0; i < full.length; i++) full[i] = (i * 7) % 256
      const sha256 = createHash('sha256').update(full).digest('hex')

      // Always answers 200 with the full body, regardless of any Range header — simulates a server/CDN
      // that doesn't support byte ranges.
      const mock = await startMockServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(full.length) })
        res.end(full)
      })
      try {
        const spec: LocalModelFile = { url: `${mock.url}/no-range.gguf`, bytes: full.length, sha256 }
        const dest = modelPaths('qwen3.5-2b').gguf
        mkdirSync(dirname(dest), { recursive: true })
        // A stale partial file whose bytes are NOT a real prefix of `full` — proves the fallback discards
        // it rather than corrupting the hash by mixing it with the restarted response.
        writeFileSync(`${dest}.part`, Buffer.alloc(1500, 0xff))

        await downloadModelFile('qwen3.5-2b', 'gguf', spec, new AbortController().signal)

        expect(statSync(dest).size).toBe(full.length)
        expect(readFileSync(dest).equals(full)).toBe(true)
      } finally {
        await mock.close()
      }
    })
  })

  // ─── End-to-end via the public API (still against the local mock, never real HF) ────────────────
  describe('downloadModel / isDownloaded / deleteModel / cancelDownload', () => {
    it('cancelDownload aborts an in-flight transfer', async () => {
      const full = Buffer.alloc(2_000_000, 1) // large enough that abort can land mid-stream
      const sha256 = createHash('sha256').update(full).digest('hex')
      const mock = await startMockServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(full.length) })
        // Trickle the body so the abort has time to land before the stream finishes.
        let i = 0
        const chunkSize = 1024
        const timer = setInterval(() => {
          if (i >= full.length) {
            clearInterval(timer)
            res.end()
            return
          }
          res.write(full.subarray(i, i + chunkSize))
          i += chunkSize
        }, 1)
        res.on('close', () => clearInterval(timer))
      })
      try {
        const spec: LocalModelFile = { url: `${mock.url}/big.gguf`, bytes: full.length, sha256 }
        const dest = modelPaths('qwen3.5-0.8b').gguf
        const controller = new AbortController()
        const promise = downloadModelFile('qwen3.5-0.8b', 'gguf', spec, controller.signal)
        setTimeout(() => controller.abort(), 20)
        await expect(promise).rejects.toThrow()
        expect(existsSync(dest)).toBe(false) // never renamed into place — the transfer never completed
      } finally {
        await mock.close()
      }
    })

    it('isDownloaded/listModels reflect disk state; deleteModel removes the files', () => {
      const entry = LOCAL_MODELS[0]
      const paths = modelPaths(entry.id)
      mkdirSync(paths.dir, { recursive: true })
      writeFileSync(paths.gguf, Buffer.alloc(entry.gguf.bytes))
      writeFileSync(paths.mmproj, Buffer.alloc(entry.mmproj.bytes))

      expect(isDownloaded(entry.id)).toBe(true)
      expect(listModels().find((m) => m.id === entry.id)?.downloaded).toBe(true)

      deleteModel(entry.id)

      expect(isDownloaded(entry.id)).toBe(false)
      expect(existsSync(paths.dir)).toBe(false)
      expect(listModels().find((m) => m.id === entry.id)?.downloaded).toBe(false)
    })

    it('cancelDownload on a model with no in-flight transfer is a harmless no-op', () => {
      expect(() => cancelDownload('qwen3.5-0.8b')).not.toThrow()
    })
  })

  // ─── Renderer-safe metadata ──────────────────────────────────────────────────────────────────
  describe('listModels — renderer-safe metadata', () => {
    it('returns exactly the documented fields and never a path-like string', () => {
      const models = listModels()
      expect(models).toHaveLength(2)
      for (const m of models) {
        expect(Object.keys(m).sort()).toEqual(
          ['downloaded', 'ggufBytes', 'id', 'label', 'minTotalRamGB', 'mmprojBytes', 'totalBytes'].sort()
        )
        for (const [key, value] of Object.entries(m)) {
          if (typeof value === 'string') {
            expect(value, `field "${key}" leaked a path-like string`).not.toContain('/')
            expect(value, `field "${key}" leaked the userData directory`).not.toContain(userData)
          }
        }
        expect(typeof m.downloaded).toBe('boolean')
        expect(m.totalBytes).toBe(m.ggufBytes + m.mmprojBytes)
      }
    })
  })
})
