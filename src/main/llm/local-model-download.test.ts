import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron')
vi.mock('../logger', () => ({ auditLog: vi.fn(), mainLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const ramState = vi.hoisted(() => ({ totalMemBytes: 64 * 1024 ** 3 }))
// Free disk space is steerable the same way RAM is. Default is deliberately huge so every existing
// test behaves as before; only the preflight test lowers it.
const diskState = vi.hoisted(() => ({ freeBytes: 512 * 1024 ** 3 }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    statfsSync: () => ({ bsize: 4096, bavail: Math.floor(diskState.freeBytes / 4096) })
  }
})
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, totalmem: () => ramState.totalMemBytes }
})

import { app, net } from 'electron'
import { ensureLocalModel, localModelDownloadState, shouldFetchWeights } from './local-model-download'
import { listModels, modelPaths, type LocalModelEntry } from './local-models'

const REPO_ROOT = join(__dirname, '..', '..', '..')
const source = readFileSync(join(REPO_ROOT, 'src', 'main', 'llm', 'local-model-download.ts'), 'utf8')

/**
 * The weights are no longer shipped inside the installer, so this module is now the ONLY place
 * installed application code fetches model bytes from the network. Bundling used to provide the
 * supply-chain guarantee; these checks are what replace it. The integrity rules are asserted at source
 * level on purpose — the real download is ~763 MB and a unit test must not perform it — while transport
 * and download state are exercised for real against a stubbed net.fetch.
 */
describe('local model first-run downloader', () => {
  it('verifies the pinned sha256 and refuses to keep a mismatch', () => {
    expect(source).toMatch(/sha256/)
    // A mismatching download must be removed, never left where a later run would trust its presence.
    expect(source).toMatch(/does not match the pinned/)
    expect(source).toMatch(/rmSync\(partial, \{ force: true \}\)/)
  })

  it('checks the declared Content-Length before writing any bytes', () => {
    // Catches a redirect to a login/error page or a swapped asset without streaming it to disk first.
    expect(source).toMatch(/content-length/)
    expect(source).toMatch(/server declared/)
  })

  it('writes to a .partial file and renames only after verification', () => {
    const partialIdx = source.indexOf('`${dest}.partial`')
    const renameIdx = source.indexOf('renameSync(partial, dest)')
    const shaCheckIdx = source.indexOf('does not match the pinned')
    expect(partialIdx).toBeGreaterThan(-1)
    expect(renameIdx).toBeGreaterThan(-1)
    // The rename must come AFTER the hash comparison, or a tampered file briefly exists under the real
    // name and a crash in between would leave it there permanently.
    expect(renameIdx).toBeGreaterThan(shaCheckIdx)
  })

  it('never throws — a failed download must not break app startup', () => {
    // Métis Local is one route among several. Offline, proxied, or disk-full machines keep working on
    // the cloud/CLI routes and retry next launch.
    expect(source).toMatch(/Resolves true when the model is ready\. Never throws/)
    expect(source).toMatch(/return false/)
  })

  it('deduplicates concurrent callers instead of racing for the same files', () => {
    expect(source).toMatch(/if \(inFlight\) return inFlight/)
  })

  it('MQA-185 — routes the weight fetch through the proxy-aware transport, never node:https', () => {
    // node:https honours neither HTTP(S)_PROXY nor the OS/PAC proxy, and install-proxy.ts's
    // setGlobalDispatcher only rebinds undici's fetch. A node:https request here is the one outbound
    // call in the main process a corporate proxy cannot carry — on the only path to the weights.
    expect(source).toMatch(/import \{ net \} from 'electron'/)
    expect(source).toMatch(/net\.fetch\(/)
    expect(source).not.toMatch(/from 'node:https'/)
    expect(source).not.toMatch(/from 'node:http'/)
    // No plaintext URL for weights, in any form.
    expect(source).not.toMatch(/http:\/\/[a-z]/i)
  })

  it('MQA-185 — keeps a rolling idle deadline, which net.fetch does not give for free', () => {
    // node:https had res.setTimeout for a connection that goes quiet mid-transfer. A Response body has
    // no equivalent, so dropping it while changing transport would silently remove a real protection.
    expect(source).toMatch(/stalled mid-download/)
    expect(source).toMatch(/AbortController/)
  })
})

// ─── Behavioural: transport, download state, and the boot eligibility gate ───────────────────────────

const CHUNK_A = Buffer.from('weights-part-one')
const CHUNK_B = Buffer.from('weights-part-two')
const GGUF = Buffer.concat([CHUNK_A, CHUNK_B])
const MMPROJ = Buffer.from('mmproj-bytes')
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

const TEST_ENTRY: LocalModelEntry = {
  id: 'qwen3.5-0.8b',
  label: 'Qwen3.5 0.8B',
  minTotalRamGB: 8,
  gguf: { bytes: GGUF.length, sha256: sha(GGUF), url: 'https://huggingface.co/test/model.gguf' },
  mmproj: { bytes: MMPROJ.length, sha256: sha(MMPROJ), url: 'https://huggingface.co/test/mmproj.gguf' }
}

vi.mock('./local-models', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./local-models')>()
  return { ...actual, getModel: vi.fn(() => TEST_ENTRY) }
})

function bodyOf(chunks: Buffer[]): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < chunks.length) c.enqueue(new Uint8Array(chunks[i++]))
      else c.close()
    }
  })
}

function responseOf(chunks: Buffer[], total: number): unknown {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-length': String(total) }),
    body: bodyOf(chunks)
  }
}

describe('MQA-185/186 — the first-run fetch is proxy-aware and observable', () => {
  let userData: string
  const mockGetPath = app.getPath as ReturnType<typeof vi.fn>
  const mockFetch = net.fetch as unknown as ReturnType<typeof vi.fn>

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'metis-dl-test-'))
    mockGetPath.mockImplementation((name: string) => (name === 'userData' ? userData : join(userData, name)))
    ramState.totalMemBytes = 64 * 1024 ** 3
    // Reset per test: the preflight test lowers this and must not leak into its neighbours.
    diskState.freeBytes = 512 * 1024 ** 3
    mockFetch.mockReset()
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
  })

  it('MQA-185 — fetches the weights over Electron net.fetch so a corporate proxy can carry them', async () => {
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('model.gguf')
          ? responseOf([CHUNK_A, CHUNK_B], GGUF.length)
          : responseOf([MMPROJ], MMPROJ.length)
      )
    )

    await expect(ensureLocalModel('qwen3.5-0.8b')).resolves.toBe(true)

    expect(mockFetch).toHaveBeenCalledWith('https://huggingface.co/test/model.gguf', expect.anything())
    expect(mockFetch).toHaveBeenCalledWith('https://huggingface.co/test/mmproj.gguf', expect.anything())
    const paths = modelPaths('qwen3.5-0.8b')
    expect(readFileSync(paths.gguf)).toEqual(GGUF)
    expect(readFileSync(paths.mmproj)).toEqual(MMPROJ)
  })

  it('MQA-186/187 — a failed fetch reports itself as a failed download, not as missing files', async () => {
    mockFetch.mockRejectedValue(new Error('connect ETIMEDOUT'))

    await expect(ensureLocalModel('qwen3.5-0.8b')).resolves.toBe(false)

    expect(localModelDownloadState()).toMatchObject({ modelId: 'qwen3.5-0.8b', status: 'failed' })
    expect(listModels(localModelDownloadState())[0]).toMatchObject({
      ready: false,
      unavailableReason: 'download-failed'
    })
  })

  // Filling a startup volume to zero does not fail politely. Observed 2026-08-24 on a volume at 98%:
  // Chromium CHECK()s on a failed write and aborts with SIGTRAP, and the Crashpad handler that would
  // report it dies the same way — three separate Electron binaries and the crash handler itself all
  // died with `brk 0` within seconds of launch, with no dialog and no log. The module contract always
  // promised a machine "short on disk simply keeps using the cloud/CLI routes"; nothing enforced it,
  // and the only disk check ran AFTER the volume was already full. At 3.58 GB (Qwen3.5 4B, up from
  // 763 MB) that gap stopped being theoretical.
  it('refuses the download when the volume cannot hold it, without touching the network', async () => {
    // Enough for the weights themselves but not for weights + headroom.
    diskState.freeBytes = GGUF.length + 1024
    mockFetch.mockResolvedValue(responseOf([GGUF], GGUF.length))

    await expect(ensureLocalModel('qwen3.5-0.8b')).resolves.toBe(false)

    // The point of a PREflight: no request is issued at all, so nothing is streamed to a full disk.
    expect(mockFetch).not.toHaveBeenCalled()
    expect(localModelDownloadState()).toMatchObject({ modelId: 'qwen3.5-0.8b', status: 'failed' })
    expect(listModels(localModelDownloadState())[0]).toMatchObject({
      ready: false,
      unavailableReason: 'download-failed'
    })
  })

  it('proceeds when free space cannot be measured, rather than blocking a download that would work', () => {
    // Unmeasurable is not insufficient. If statfs throws — an exotic filesystem, a path that vanished
    // between mkdir and the check — the download proceeds. The post-write size and SHA-256 checks
    // still guard the result, so failing open here cannot let a bad file be kept.
    expect(source).toContain('statfsSync(dir)')
    const fn = source.slice(source.indexOf('function assertRoomFor'))
    const body = fn.slice(0, fn.indexOf('const REQUEST_TIMEOUT_MS'))
    expect(body).toContain('catch {')
    expect(body.slice(body.indexOf('catch {'))).toContain('return')
  })

  it('MQA-186 — reports real progress while the transfer is in flight', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    let sawFirstChunk: () => void = () => {}
    const firstChunk = new Promise<void>((r) => {
      sawFirstChunk = r
    })

    mockFetch.mockImplementation((url: string) => {
      if (!url.endsWith('model.gguf')) return Promise.resolve(responseOf([MMPROJ], MMPROJ.length))
      let stage = 0
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-length': String(GGUF.length) }),
        body: new ReadableStream<Uint8Array>({
          async pull(c) {
            if (stage === 0) {
              stage = 1
              c.enqueue(new Uint8Array(CHUNK_A))
              sawFirstChunk()
              return
            }
            if (stage === 1) {
              stage = 2
              await gate
              c.enqueue(new Uint8Array(CHUNK_B))
              return
            }
            c.close()
          }
        })
      })
    })

    const done = ensureLocalModel('qwen3.5-0.8b')
    await firstChunk
    await new Promise((r) => setTimeout(r, 20))

    const mid = localModelDownloadState()
    expect(mid.status).toBe('downloading')
    expect(mid.progress).toBeGreaterThan(0)
    expect(mid.progress).toBeLessThan(1)
    expect(listModels(mid)[0]).toMatchObject({ ready: false, unavailableReason: 'downloading' })
    expect(listModels(mid)[0].downloadProgress).toBeGreaterThan(0)

    release()
    await expect(done).resolves.toBe(true)
    expect(localModelDownloadState().status).toBe('idle')
  })

  it('MQA-186 — does not fetch 763 MB onto a machine that can never load it', () => {
    ramState.totalMemBytes = 4 * 1024 ** 3
    expect(shouldFetchWeights('qwen3.5-0.8b', true)).toBe(false)
    ramState.totalMemBytes = 8 * 1024 ** 3
    expect(shouldFetchWeights('qwen3.5-0.8b', true)).toBe(true)
  })

  it('MQA-186 — Local AI switched off is a real deferral: no download is started', () => {
    expect(shouldFetchWeights('qwen3.5-0.8b', false)).toBe(false)
  })

  it('MQA-186 — an already-provisioned model reports idle, not downloading', async () => {
    const paths = modelPaths('qwen3.5-0.8b')
    mkdirSync(paths.dir, { recursive: true })
    writeFileSync(paths.gguf, GGUF)
    writeFileSync(paths.mmproj, MMPROJ)

    await expect(ensureLocalModel('qwen3.5-0.8b')).resolves.toBe(true)
    expect(net.fetch).not.toHaveBeenCalled()
    expect(localModelDownloadState()).toMatchObject({ status: 'idle' })
    expect(existsSync(`${paths.gguf}.partial`)).toBe(false)
  })
})
