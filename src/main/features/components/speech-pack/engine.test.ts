import { randomBytes } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isSafeEntryName } from './archive'
import { DISK_HEADROOM_BYTES, createSpeechPackEngine, type ActivationStep, type SpeechPackEngineOptions, type SpeechPackState } from './engine'
import type { SpeechPackComponent, SpeechPackComponentId } from './manifest'
import { rangeHandler, serve, sha256Hex, type FixtureServer } from './test-server'

const WHISPER: SpeechPackComponentId = 'asr.whisper-base-q8'
const PARAKEET: SpeechPackComponentId = 'asr.parakeet-tdt-0.6b-v3-int8'

const contents: Record<string, Buffer> = {
  'a.bin': randomBytes(30_000),
  'sub/b.bin': randomBytes(50_000),
  'p.bin': randomBytes(20_000)
}
const wav = randomBytes(4_000)
const fixture = { bytes: wav.length, sha256: sha256Hex(wav) }

const fileOf = (path: string) => ({ path, bytes: contents[path].length, sha256: sha256Hex(contents[path]) })
const total = (c: SpeechPackComponent): number => c.files.reduce((n, f) => n + f.bytes, 0)

let dir: string
let root: string
let server: FixtureServer | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'speech-pack-engine-'))
  root = join(dir, 'packs')
  writeFileSync(join(dir, 'en.wav'), wav)
})
afterEach(async () => {
  await server?.close()
  server = undefined
  rmSync(dir, { recursive: true, force: true })
})

const serveFiles = (extra?: Parameters<typeof rangeHandler>[1]): Promise<FixtureServer> =>
  serve((req, res, i) => {
    const key = decodeURIComponent((req.url ?? '').replace(/^\/pin\//, ''))
    const body = contents[key]
    if (!body) {
      res.statusCode = 404
      res.end()
      return
    }
    rangeHandler(body, extra)(req, res, i)
  })

const whisper = (base: string): SpeechPackComponent => ({
  id: WHISPER,
  version: '1',
  files: [fileOf('a.bin'), fileOf('sub/b.bin')],
  source: { kind: 'files', baseUrl: `${base}/pin` }
})
const parakeetFiles = (base: string): SpeechPackComponent => ({
  id: PARAKEET,
  version: '1',
  files: [fileOf('p.bin')],
  source: { kind: 'files', baseUrl: `${base}/pin` }
})

const make = (components: SpeechPackComponent[], over: Partial<SpeechPackEngineOptions> = {}) =>
  createSpeechPackEngine({
    rootDir: root,
    fixtureWavPath: join(dir, 'en.wav'),
    fixture,
    selfTest: async () => 'hello world',
    components,
    sleep: async () => undefined,
    freeBytes: () => Number.MAX_SAFE_INTEGER,
    emitIntervalMs: 0,
    ...over
  })

const packMatches = (c: SpeechPackComponent, at: string): boolean =>
  c.files.every((f) => existsSync(join(at, f.path)) && sha256Hex(readFileSync(join(at, f.path))) === f.sha256)
const marker = (id: SpeechPackComponentId): string => join(root, id, 'active.json')

describe('speech-pack engine', () => {
  it('downloads, verifies, self-tests and activates a pack', async () => {
    server = await serveFiles()
    const c = whisper(server.base)
    const selfTest = vi.fn(async ({ packDir, wavPath }: { packDir: string; wavPath: string }) => {
      expect(packMatches(c, packDir)).toBe(true)
      expect(readFileSync(wavPath).equals(wav)).toBe(true)
      return 'hello'
    })
    const engine = make([c], { selfTest })
    engine.enqueue([WHISPER])
    await engine.whenIdle()
    expect(engine.getState(WHISPER)).toEqual({ status: 'ready' })
    expect(selfTest).toHaveBeenCalledTimes(1)
    expect(packMatches(c, join(root, WHISPER, '1'))).toBe(true)
    expect(JSON.parse(readFileSync(marker(WHISPER), 'utf8'))).toEqual({ schema: 1, component: WHISPER, version: '1' })
    expect(existsSync(join(root, '.staging', WHISPER, '1'))).toBe(false)
  })

  it('refuses on a disk shortfall with the required and free bytes, and writes nothing', async () => {
    server = await serveFiles()
    const c = whisper(server.base)
    const engine = make([c], { freeBytes: () => 1_000 })
    engine.enqueue([WHISPER])
    await engine.whenIdle()
    expect(engine.getState(WHISPER)).toEqual({
      status: 'error',
      kind: 'disk',
      requiredBytes: total(c) + DISK_HEADROOM_BYTES,
      freeBytes: 1_000
    })
    expect(server.requests).toHaveLength(0)
    expect(existsSync(root)).toBe(false)
  })

  it('needs exactly the remaining bytes plus 512 MB of headroom', async () => {
    server = await serveFiles()
    const c = whisper(server.base)
    const need = total(c) + DISK_HEADROOM_BYTES
    const short = make([c], { freeBytes: () => need - 1 })
    short.enqueue([WHISPER])
    await short.whenIdle()
    expect(short.getState(WHISPER).status).toBe('error')
    const enough = make([c], { freeBytes: () => need })
    enough.enqueue([WHISPER])
    await enough.whenIdle()
    expect(enough.getState(WHISPER)).toEqual({ status: 'ready' })
  })

  it('does not fetch a pack whose upstream pin has not been recorded', async () => {
    const c: SpeechPackComponent = { ...whisper('http://127.0.0.1:1'), source: { kind: 'files', baseUrl: null } }
    const engine = make([c])
    engine.enqueue([WHISPER])
    await engine.whenIdle()
    expect(engine.getState(WHISPER)).toMatchObject({ status: 'error', kind: 'http' })
    expect(existsSync(root)).toBe(false)
  })

  it('reports captive when the host answers with a login page, and offline when unreachable', async () => {
    server = await serve((_req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end('<html>login</html>')
    })
    const captive = make([whisper(server.base)])
    captive.enqueue([WHISPER])
    await captive.whenIdle()
    expect(captive.getState(WHISPER)).toEqual({ status: 'error', kind: 'captive' })

    const unreachable = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    const offline = make([whisper('http://127.0.0.1:1')], { fetch: unreachable, timing: { maxAttempts: 2 } })
    offline.enqueue([WHISPER])
    await offline.whenIdle()
    expect(offline.getState(WHISPER)).toEqual({ status: 'error', kind: 'offline' })
  })

  it('reports tamper for a pack whose bytes differ from the pin', async () => {
    const flipped = Buffer.from(contents['a.bin'])
    flipped[10] ^= 0xff
    server = await serve((req, res, i) => {
      const key = (req.url ?? '').replace(/^\/pin\//, '')
      rangeHandler(key === 'a.bin' ? flipped : contents[key])(req, res, i)
    })
    const engine = make([whisper(server.base)])
    engine.enqueue([WHISPER])
    await engine.whenIdle()
    expect(engine.getState(WHISPER)).toEqual({ status: 'error', kind: 'tamper' })
    expect(existsSync(marker(WHISPER))).toBe(false)
    expect(existsSync(join(root, WHISPER, '1'))).toBe(false)
  })

  it('does not activate when the self-test decodes nothing', async () => {
    server = await serveFiles()
    const engine = make([whisper(server.base)], { selfTest: async () => '   ' })
    engine.enqueue([WHISPER])
    await engine.whenIdle()
    expect(engine.getState(WHISPER)).toMatchObject({ status: 'error' })
    expect(existsSync(marker(WHISPER))).toBe(false)
    expect(existsSync(join(root, WHISPER, '1'))).toBe(false)
  })

  it('does not activate when the self-test fixture is not the pinned one', async () => {
    server = await serveFiles()
    writeFileSync(join(dir, 'en.wav'), randomBytes(4_000))
    const selfTest = vi.fn(async () => 'text')
    const engine = make([whisper(server.base)], { selfTest })
    engine.enqueue([WHISPER])
    await engine.whenIdle()
    expect(engine.getState(WHISPER)).toMatchObject({ status: 'error', kind: 'tamper' })
    expect(selfTest).not.toHaveBeenCalled()
  })

  it('queues the selected engine first and runs one download at a time', async () => {
    server = await serveFiles()
    const engine = make([whisper(server.base), parakeetFiles(server.base)])
    engine.enqueue([WHISPER, PARAKEET], PARAKEET)
    expect(engine.getState(PARAKEET).status).toBe('downloading')
    expect(engine.getState(WHISPER).status).toBe('queued')
    await engine.whenIdle()
    const urls = server.requests.map((r) => r.url)
    expect(urls[0]).toBe('/pin/p.bin')
    expect(urls.slice(1)).toEqual(['/pin/a.bin', '/pin/sub/b.bin'])
    expect(engine.getState(WHISPER)).toEqual({ status: 'ready' })
    expect(engine.getState(PARAKEET)).toEqual({ status: 'ready' })
  })

  it('ignores a second enqueue for a pack that is already downloading', async () => {
    server = await serveFiles()
    const engine = make([whisper(server.base)])
    engine.enqueue([WHISPER])
    engine.enqueue([WHISPER])
    await engine.whenIdle()
    expect(server.requests).toHaveLength(2)
  })

  describe('cancel and pause', () => {
    const hanging = (): Promise<FixtureServer> =>
      serve((_req, res) => {
        res.setHeader('etag', '"v1"')
        res.setHeader('content-length', String(contents['a.bin'].length))
        res.write(contents['a.bin'].subarray(0, 5_000))
      })

    it('cancel stops the transfer, removes what was staged and reports cancelled', async () => {
      server = await hanging()
      const engine = make([whisper(server.base)])
      engine.enqueue([WHISPER])
      await vi.waitFor(() => expect(server?.requests.length).toBe(1))
      engine.cancel(WHISPER)
      await engine.whenIdle()
      expect(engine.getState(WHISPER)).toEqual({ status: 'error', kind: 'cancelled' })
      expect(existsSync(join(root, '.staging', WHISPER))).toBe(false)
    })

    it('cancel also works on a queued pack', async () => {
      server = await hanging()
      const engine = make([whisper(server.base), parakeetFiles(server.base)])
      engine.enqueue([WHISPER, PARAKEET], WHISPER)
      engine.cancel(PARAKEET)
      expect(engine.getState(PARAKEET)).toEqual({ status: 'error', kind: 'cancelled' })
      engine.cancel(WHISPER)
      await engine.whenIdle()
    })

    it('pause keeps the partial file and a later enqueue resumes with Range', async () => {
      let healthy = false
      const ok = rangeHandler(contents['a.bin'])
      server = await serve((req, res, i) => {
        if (healthy) {
          ok(req, res, i)
          return
        }
        res.setHeader('etag', '"v1"')
        res.setHeader('content-length', String(contents['a.bin'].length))
        res.write(contents['a.bin'].subarray(0, 5_000))
      })
      const c = whisper(server.base)
      const engine = make([{ ...c, files: [c.files[0]] }])
      engine.enqueue([WHISPER])
      await vi.waitFor(() => expect(server?.requests.length).toBe(1))
      await vi.waitFor(() => expect(existsSync(join(root, '.staging', WHISPER, '1', 'a.bin.partial'))).toBe(true))
      engine.pause(WHISPER)
      await engine.whenIdle()
      expect(engine.getState(WHISPER)).toEqual({ status: 'paused' })
      expect(existsSync(join(root, '.staging', WHISPER, '1', 'a.bin.partial'))).toBe(true)

      healthy = true
      engine.enqueue([WHISPER])
      await engine.whenIdle()
      expect(engine.getState(WHISPER)).toEqual({ status: 'ready' })
      expect(server.requests[1].headers.range).toMatch(/^bytes=\d+-$/)
    })
  })

  describe('activation kill points', () => {
    const STEPS: ActivationStep[] = ['staged-verified', 'self-tested', 'renamed', 'marker-tmp-written', 'marker-written']

    it.each(STEPS)('a crash after %s never leaves a marker without a whole pack, or a half-filled pack', async (step) => {
      server = await serveFiles()
      const c = whisper(server.base)
      const killed = make([c], {
        onActivationStep: (at) => {
          if (at === step) throw new Error('killed')
        }
      })
      killed.enqueue([WHISPER])
      await killed.whenIdle()

      const active = join(root, WHISPER, '1')
      if (existsSync(marker(WHISPER))) expect(packMatches(c, active)).toBe(true)
      if (existsSync(active)) expect(packMatches(c, active)).toBe(true)
      if (step === 'staged-verified' || step === 'self-tested') {
        expect(existsSync(marker(WHISPER))).toBe(false)
        expect(existsSync(active)).toBe(false)
      }
      if (step !== 'marker-written') expect(existsSync(marker(WHISPER))).toBe(false)

      // The next start recovers: a complete unmarked pack is adopted, an unfinished one is finished.
      const before = server.requests.length
      const next = make([c])
      await next.initialise()
      next.enqueue([WHISPER])
      await next.whenIdle()
      expect(next.getState(WHISPER)).toEqual({ status: 'ready' })
      expect(packMatches(c, active)).toBe(true)
      expect(JSON.parse(readFileSync(marker(WHISPER), 'utf8')).component).toBe(WHISPER)
      // Verified files are never fetched again.
      expect(server.requests.length).toBe(before)
    })

    it('removes a corrupt pack found on start instead of adopting it', async () => {
      server = await serveFiles()
      const c = whisper(server.base)
      const first = make([c])
      first.enqueue([WHISPER])
      await first.whenIdle()
      writeFileSync(join(root, WHISPER, '1', 'a.bin'), randomBytes(30_000))

      const next = make([c])
      await next.initialise()
      expect(next.getState(WHISPER)).toEqual({ status: 'not-installed' })
      expect(existsSync(marker(WHISPER))).toBe(false)
      expect(existsSync(join(root, WHISPER, '1'))).toBe(false)
    })
  })

  describe('events', () => {
    it('delivers at most one event per 250 ms per pack and ends on the latest state', async () => {
      server = await serveFiles()
      const engine = make([whisper(server.base)], { emitIntervalMs: 250 })
      const seen: Array<{ at: number; state: SpeechPackState }> = []
      engine.subscribe((e) => seen.push({ at: Date.now(), state: e.state }))
      engine.enqueue([WHISPER])
      await engine.whenIdle()
      await vi.waitFor(() => expect(seen.at(-1)?.state).toEqual({ status: 'ready' }), { timeout: 3_000 })
      for (let i = 1; i < seen.length; i++) expect(seen[i].at - seen[i - 1].at).toBeGreaterThanOrEqual(240)
    })

    it('carries only ids, counts and kinds — no path, URL or content', async () => {
      server = await serveFiles()
      const engine = make([whisper(server.base)])
      const seen: unknown[] = []
      engine.subscribe((e) => seen.push(e))
      engine.enqueue([WHISPER])
      await engine.whenIdle()
      const text = JSON.stringify([seen, engine.states()])
      expect(text).not.toContain(dir)
      expect(text).not.toContain('http')
      expect(text).not.toContain('hello')
    })
  })

  describe('archive sources', () => {
    const archiveBytes = randomBytes(10_000)
    const prefix = 'pack-dir'
    const archiveComponent = (base: string): SpeechPackComponent => ({
      id: PARAKEET,
      version: '1',
      files: [fileOf('p.bin')],
      source: {
        kind: 'archive',
        archive: { url: `${base}/pin/archive.bin`, bytes: archiveBytes.length, sha256: sha256Hex(archiveBytes) },
        entryPrefix: prefix,
        extractCapBytes: 100_000
      }
    })
    const serveArchive = (): Promise<FixtureServer> => serve((req, res, i) => rangeHandler(archiveBytes)(req, res, i))
    const write = (dest: string, data: Buffer): void => {
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, data)
    }

    it('extracts, checks each file against its own pin and activates', async () => {
      server = await serveArchive()
      const engine = make([archiveComponent(server.base)], {
        extractArchive: async (_archive, dest) => {
          write(join(dest, prefix, 'p.bin'), contents['p.bin'])
          write(join(dest, prefix, 'test_wavs', 'en.wav'), wav)
        }
      })
      engine.enqueue([PARAKEET])
      await engine.whenIdle()
      expect(engine.getState(PARAKEET)).toEqual({ status: 'ready' })
      expect(readdirSync(join(root, PARAKEET, '1'))).toEqual(['p.bin'])
      expect(existsSync(join(root, '.staging', PARAKEET, 'work'))).toBe(false)
    })

    it('reports tamper when an extracted file does not match its pin', async () => {
      server = await serveArchive()
      const engine = make([archiveComponent(server.base)], {
        extractArchive: async (_archive, dest) => write(join(dest, prefix, 'p.bin'), randomBytes(20_000))
      })
      engine.enqueue([PARAKEET])
      await engine.whenIdle()
      expect(engine.getState(PARAKEET)).toEqual({ status: 'error', kind: 'tamper' })
      expect(existsSync(marker(PARAKEET))).toBe(false)
    })

    it('caps the extracted size', async () => {
      server = await serveArchive()
      const engine = make([archiveComponent(server.base)], {
        extractArchive: async (_archive, dest) => {
          write(join(dest, prefix, 'p.bin'), contents['p.bin'])
          write(join(dest, prefix, 'bomb.bin'), Buffer.alloc(200_000))
        }
      })
      engine.enqueue([PARAKEET])
      await engine.whenIdle()
      expect(engine.getState(PARAKEET)).toEqual({ status: 'error', kind: 'tamper' })
    })

    it('rejects an extracted link', async () => {
      server = await serveArchive()
      const engine = make([archiveComponent(server.base)], {
        extractArchive: async (_archive, dest) => {
          write(join(dest, prefix, 'p.bin'), contents['p.bin'])
          linkSync(join(dest, prefix, 'p.bin'), join(dest, prefix, 'alias.bin'))
        }
      })
      engine.enqueue([PARAKEET])
      await engine.whenIdle()
      expect(engine.getState(PARAKEET)).toEqual({ status: 'error', kind: 'tamper' })
    })

    it('counts the archive and the extraction peak in the disk check', async () => {
      server = await serveArchive()
      const c = archiveComponent(server.base)
      const need = archiveBytes.length + total(c) + DISK_HEADROOM_BYTES
      const engine = make([c], { freeBytes: () => need - 1, extractArchive: async () => undefined })
      engine.enqueue([PARAKEET])
      await engine.whenIdle()
      expect(engine.getState(PARAKEET)).toEqual({ status: 'error', kind: 'disk', requiredBytes: need, freeBytes: need - 1 })
      expect(server.requests).toHaveLength(0)
    })

    it('refuses an archive pack without a recorded archive pin', async () => {
      const c: SpeechPackComponent = { ...archiveComponent('http://127.0.0.1:1'), source: { kind: 'archive', archive: null, entryPrefix: prefix, extractCapBytes: 1 } }
      const engine = make([c])
      engine.enqueue([PARAKEET])
      await engine.whenIdle()
      expect(engine.getState(PARAKEET)).toMatchObject({ status: 'error', kind: 'http' })
    })
  })
})

describe('isSafeEntryName', () => {
  it.each(['../evil', 'a/../../evil', '/abs/path', 'C:/win', 'C:\\win', 'a\\b', '', 'a\0b'])('rejects %j', (name) => {
    expect(isSafeEntryName(name)).toBe(false)
  })
  it.each(['a.bin', 'dir/file.onnx', 'test_wavs/en.wav'])('accepts %j', (name) => {
    expect(isSafeEntryName(name)).toBe(true)
  })
})
