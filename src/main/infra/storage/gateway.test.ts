import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { lookup } from 'node:dns/promises'
import { tmpdir } from 'node:os'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { basename, isAbsolute, join, relative, sep } from 'node:path'

vi.mock('../../logger', () => ({ mainLog: { info: vi.fn(), warn: vi.fn() }, auditLog: vi.fn() }))
vi.mock('../../mac-helper', () => ({ macStatFlagsSpawnSpec: vi.fn(() => null) }))

import { createFifo, releaseFifo } from '../../../../scripts/qa/fixtures/fifo.mjs'
import type { ContentPresence, DatalessDetector, FileVersion } from './dataless'
import { createStorageGateway, threadpoolSize, type StorageFs } from './gateway'

const ROOT = join(sep, 'meetings')
const ROOT2 = join(sep, 'meetings2')

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------------------------------

type FsMethod = 'readdir' | 'readFile' | 'realpath' | 'stat' | 'lstat'

interface HeldCall {
  release(): void
  fail(code: string): void
}

interface TestFs extends StorageFs {
  calls: string[]
  /** Every call's exact full path, in order — lets a test tell two roots apart even when `calls` (kept
   *  basename-only for the other tests' assertions) cannot. */
  paths: string[]
  inFlight(): number
  hold(method: FsMethod, name: string): HeldCall
  fail(method: FsMethod, name: string, code?: string): void
  touch(name: string): void
  /** Marks an already-registered name as a symlink, the way `lstat` alone (never `stat`) would report it. */
  markSymlink(name: string): void
}

function errnoError(code?: string): NodeJS.ErrnoException {
  const error = new Error(code ?? 'no errno code') as NodeJS.ErrnoException
  if (code) error.code = code
  return error
}

/** An in-memory StorageFs keyed by full path, as the design's harness spec requires (`join(ROOT, rel)`):
 *  a plain name registers under ROOT, an already-absolute name registers under itself (P3 exercises two
 *  roots this way). Content lookups use the exact path the gateway passed in, so a gateway that resolved
 *  the wrong root finds nothing there — 'ENOENT', not another root's file of the same name. `hold`/`fail`
 *  still gate the NEXT call to (method, basename); later calls to the same pair are unaffected unless
 *  gated again. */
function memoryFs(files: Record<string, string>): TestFs {
  const entries = new Map<string, { content: string; mtimeMs: number; ctimeMs: number }>()
  const keyOf = (name: string): string => (isAbsolute(name) ? name : join(ROOT, name))
  for (const [name, content] of Object.entries(files)) entries.set(keyOf(name), { content, mtimeMs: 1_000, ctimeMs: 1_000 })
  const symlinks = new Set<string>()

  const calls: string[] = []
  const paths: string[] = []
  let inflight = 0
  const gates = new Map<string, Array<() => Promise<void>>>()

  function pushGate(method: FsMethod, name: string, gate: () => Promise<void>): void {
    const key = `${method} ${name}`
    const queue = gates.get(key) ?? []
    queue.push(gate)
    gates.set(key, queue)
  }

  async function invoke<T>(method: FsMethod, path: string, produce: () => T): Promise<T> {
    const name = basename(path)
    calls.push(`${method} ${name}`)
    paths.push(path)
    inflight += 1
    try {
      const gate = gates.get(`${method} ${name}`)?.shift()
      if (gate) await gate()
      return produce()
    } finally {
      inflight -= 1
    }
  }

  return {
    calls,
    paths,
    inFlight: () => inflight,
    hold(method, name) {
      let resolveFn!: () => void
      let rejectFn!: (error: unknown) => void
      const gate = new Promise<void>((resolve, reject) => {
        resolveFn = resolve
        rejectFn = reject
      })
      pushGate(method, name, () => gate)
      return { release: () => resolveFn(), fail: (code) => rejectFn(errnoError(code)) }
    },
    fail(method, name, code) {
      pushGate(method, name, () => Promise.reject(errnoError(code)))
    },
    touch(name) {
      const entry = entries.get(keyOf(name))
      if (entry) {
        entry.mtimeMs += 1
        entry.ctimeMs += 1
      }
    },
    markSymlink(name) {
      symlinks.add(keyOf(name))
    },
    async readdir(path) {
      return invoke('readdir', path, () => [...entries.keys()].map((key) => basename(key)))
    },
    async stat(path) {
      return invoke('stat', path, () => {
        const entry = entries.get(path)
        if (!entry) throw errnoError('ENOENT')
        return { mtimeMs: entry.mtimeMs, ctimeMs: entry.ctimeMs, size: entry.content.length }
      })
    },
    async readFile(path) {
      return invoke('readFile', path, () => {
        const entry = entries.get(path)
        if (!entry) throw errnoError('ENOENT')
        return Buffer.from(entry.content)
      })
    },
    async realpath(path) {
      return invoke('realpath', path, () => path)
    },
    async lstat(path) {
      return invoke('lstat', path, () => {
        if (!entries.has(path)) throw errnoError('ENOENT')
        return { isSymbolicLink: symlinks.has(path) }
      })
    }
  }
}

/** A detector fake that answers by basename: cloud* -> dataless, odd* -> unknown, else local. */
function fakeDetector() {
  const classify = vi.fn(async (files: readonly FileVersion[]): Promise<Map<string, ContentPresence>> => {
    const result = new Map<string, ContentPresence>()
    for (const file of files) {
      const name = basename(file.path)
      const presence: ContentPresence = name.startsWith('cloud') ? 'dataless' : name.startsWith('odd') ? 'unknown' : 'local'
      result.set(file.path, presence)
    }
    return result
  })
  return { classify }
}

function localDetector(): DatalessDetector {
  return { classify: async (files) => new Map(files.map((file): [string, ContentPresence] => [file.path, 'local'])) }
}

function datalessDetector(): DatalessDetector {
  return { classify: async (files) => new Map(files.map((file): [string, ContentPresence] => [file.path, 'dataless'])) }
}

/** Drains pending microtasks (and any timer already due) `times` times, without moving the fake clock
 *  forward. None of the chains under test here depend on a timer firing early, only on enough microtask
 *  turns to walk through admission, the presence queue and the in-memory fs. */
async function flush(times = 30): Promise<void> {
  for (let i = 0; i < times; i++) await vi.advanceTimersByTimeAsync(0)
}

// ---------------------------------------------------------------------------------------------------
// T1 — threadpoolSize
// ---------------------------------------------------------------------------------------------------

describe('threadpoolSize', () => {
  const table: Array<[string | undefined, number]> = [
    [undefined, 4],
    ['8', 8],
    ['0', 1],
    ['abc', 1],
    ['', 1],
    ['-3', 1],
    ['2000', 1024],
    [' 6', 6]
  ]

  it.each(table)('reads UV_THREADPOOL_SIZE %p as %i, the way libuv does, never larger', (value, expected) => {
    expect(threadpoolSize(value)).toBe(expected)
  })
})

// ---------------------------------------------------------------------------------------------------
// G — admission, deadlines, abort
// ---------------------------------------------------------------------------------------------------

describe('admission cap (G1)', () => {
  const table: Array<[number, number]> = [
    [4, 2],
    [6, 4],
    [3, 1],
    [1, 1]
  ]

  it.each(table)('runs at most poolSize - 2 meetings-root fs calls at once, and at least one (pool %i, cap %i)', async (poolSize, cap) => {
    const names = Array.from({ length: cap + 1 }, (_, i) => `f${i}.md`)
    const fs = memoryFs(Object.fromEntries(names.map((name) => [name, 'x'])))
    const detector = fakeDetector()
    const gateway = createStorageGateway({ root: () => ROOT, detector, fs, poolSize })

    const holds = names.map((name) => fs.hold('readFile', name))
    const reads = names.map((name) => gateway.read(name))
    await flush()

    expect(fs.inFlight()).toBe(cap)
    const started = names.filter((name) => fs.calls.includes(`readFile ${name}`))
    const blocked = names.filter((name) => !fs.calls.includes(`readFile ${name}`))
    expect(started).toHaveLength(cap)
    expect(blocked).toHaveLength(1)

    // Releasing one started call frees its permit for the one that never got to start.
    holds[names.indexOf(started[0])].release()
    await flush()
    expect(fs.calls).toContain(`readFile ${blocked[0]}`)

    for (const name of names) {
      if (name === started[0]) continue
      holds[names.indexOf(name)].release()
    }
    const results = await Promise.all(reads)
    expect(results.every((result) => result.status === 'ok')).toBe(true)
  })
})

describe('deadlines (G2-G3)', () => {
  it("a deadline answers 'timeout' while the blocked call keeps its permit", async () => {
    const fs = memoryFs({ 'a.md': 'A', 'b.md': 'B', 'c.md': 'C' })
    const detector = fakeDetector()
    const gateway = createStorageGateway({ root: () => ROOT, detector, fs, poolSize: 3 }) // cap = 1

    const heldA = fs.hold('readFile', 'a.md')
    const readA = gateway.read('a.md')
    await flush()

    const readB = gateway.read('b.md')
    await flush()

    await vi.advanceTimersByTimeAsync(5_000)
    await expect(readA).resolves.toEqual({ status: 'timeout' })
    await expect(readB).resolves.toEqual({ status: 'degraded' })
    expect(fs.calls).not.toContain('stat b.md')

    heldA.release()
    await flush()

    await expect(gateway.read('c.md')).resolves.toMatchObject({ status: 'ok' })
  })

  it("a request that waits past its deadline is 'degraded' and never touches the file", async () => {
    const fs = memoryFs({ 'a.md': 'A', 'b.md': 'B' })
    const detector = fakeDetector()
    const gateway = createStorageGateway({ root: () => ROOT, detector, fs, poolSize: 3 }) // cap = 1

    const heldA = fs.hold('readFile', 'a.md')
    void gateway.read('a.md')
    await flush()

    const classifyB = gateway.classify(['b.md'])
    await vi.advanceTimersByTimeAsync(2_000)
    const result = await classifyB
    expect(result.get('b.md')).toEqual({ status: 'degraded' })

    heldA.release()
    await flush()
    expect(fs.calls).not.toContain('stat b.md')
  })
})

describe('abort (G4-G6)', () => {
  it("aborting a waiting request answers 'aborted' at once and its fs call never starts", async () => {
    const fs = memoryFs({ 'a.md': 'A', 'b.md': 'B' })
    const detector = fakeDetector()
    const gateway = createStorageGateway({ root: () => ROOT, detector, fs, poolSize: 3 }) // cap = 1

    const heldA = fs.hold('readFile', 'a.md')
    void gateway.read('a.md')
    await flush()

    const controller = new AbortController()
    const readB = gateway.read('b.md', { signal: controller.signal })
    await flush()

    controller.abort()
    await expect(readB).resolves.toEqual({ status: 'aborted' })
    expect(fs.calls).not.toContain('stat b.md')

    heldA.release()
    await flush()
  })

  it("aborting a running read answers 'aborted', and the call keeps its permit until it settles", async () => {
    const fs = memoryFs({ 'a.md': 'A', 'b.md': 'B' })
    const detector = fakeDetector()
    const gateway = createStorageGateway({ root: () => ROOT, detector, fs, poolSize: 3 }) // cap = 1

    const heldA = fs.hold('readFile', 'a.md')
    const controller = new AbortController()
    const readA = gateway.read('a.md', { signal: controller.signal })
    await flush()

    controller.abort()
    await expect(readA).resolves.toEqual({ status: 'aborted' })

    // The permit is still held by a's outstanding readFile: a fresh request must still wait behind it.
    const readB = gateway.read('b.md')
    await flush()
    expect(fs.calls).not.toContain('stat b.md')

    heldA.release()
    await flush()
    await expect(readB).resolves.toMatchObject({ status: 'ok' })
  })

  it('an already-aborted signal answers \'aborted\' with no fs call and no probe', async () => {
    const fs = memoryFs({ 'a.md': 'A' })
    const detector = fakeDetector()
    const gateway = createStorageGateway({ root: () => ROOT, detector, fs, poolSize: 4 })

    const controller = new AbortController()
    controller.abort()
    const result = await gateway.read('a.md', { signal: controller.signal })

    expect(result).toEqual({ status: 'aborted' })
    expect(fs.calls).toEqual([])
    expect(detector.classify).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------------------------------
// Listener fan-out — classify adds one abort listener per path to a single request signal, and that
// must never warn.
// ---------------------------------------------------------------------------------------------------

describe('listener fan-out (classify)', () => {
  it('classifying many paths under a small cap emits no MaxListenersExceededWarning', async () => {
    const names = Array.from({ length: 50 }, (_, i) => `f${i}.md`)
    const fs = memoryFs(Object.fromEntries(names.map((name) => [name, 'x'])))
    const detector = fakeDetector()
    const gateway = createStorageGateway({ root: () => ROOT, detector, fs, poolSize: 4 }) // cap = 2

    const warnings: string[] = []
    const onWarning = (warning: Error): void => {
      warnings.push(warning.name)
    }
    process.on('warning', onWarning)
    try {
      const result = await gateway.classify(names)
      await flush()
      expect(result.size).toBe(50)
    } finally {
      process.off('warning', onWarning)
    }

    expect(warnings).not.toContain('MaxListenersExceededWarning')
  })
})

// ---------------------------------------------------------------------------------------------------
// D — classification before any read
// ---------------------------------------------------------------------------------------------------

describe('classify-before-read (D1-D6)', () => {
  it('classify stats every path, probes once for the batch and classes each path', async () => {
    const fs = memoryFs({ 'a.md': 'A', 'cloud.md': 'C', 'odd.md': 'O' })
    const detector = fakeDetector()
    const gateway = createStorageGateway({ root: () => ROOT, detector, fs, poolSize: 4 })

    const result = await gateway.classify(['a.md', 'cloud.md', 'odd.md', 'gone.md', '../x.md'])

    expect(result.get('a.md')).toMatchObject({ status: 'ok' })
    expect(result.get('cloud.md')).toMatchObject({ status: 'dataless' })
    expect(result.get('odd.md')).toMatchObject({ status: 'unknown' })
    expect(result.get('gone.md')).toEqual({ status: 'missing' })
    expect(result.get('../x.md')).toEqual({ status: 'unavailable', code: 'OUTSIDE_ROOT' })

    expect(detector.classify).toHaveBeenCalledTimes(1)
    const probed = detector.classify.mock.calls[0][0] as readonly FileVersion[]
    expect(probed).toHaveLength(3)
    for (const file of probed) expect(file).toMatchObject({ mtimeMs: 1_000, ctimeMs: 1_000 })
  })

  it("classify reports a plain file's own isSymlink false and a symlink's true, from lstat alone", async () => {
    const fs = memoryFs({ 'a.md': 'A', 'linked.md': 'A' })
    fs.markSymlink('linked.md')
    const gateway = createStorageGateway({ root: () => ROOT, detector: fakeDetector(), fs, poolSize: 4 })

    const result = await gateway.classify(['a.md', 'linked.md'])

    expect(result.get('a.md')).toMatchObject({ status: 'ok', isSymlink: false })
    expect(result.get('linked.md')).toMatchObject({ status: 'ok', isSymlink: true })
    expect(fs.calls).toContain('lstat linked.md')
  })

  it('read never opens a file the detector calls dataless or unknown', async () => {
    const fs = memoryFs({ 'cloud.md': 'C', 'odd.md': 'O' })
    const detector = fakeDetector()
    const gateway = createStorageGateway({ root: () => ROOT, detector, fs, poolSize: 4 })

    await expect(gateway.read('cloud.md')).resolves.toMatchObject({ status: 'dataless' })
    await expect(gateway.read('odd.md')).resolves.toMatchObject({ status: 'unknown' })
    expect(fs.calls.some((call) => call.startsWith('realpath') || call.startsWith('readFile'))).toBe(false)
  })

  it('classify flags a non-regular file without probing it and an explicit open refuses to read it', async () => {
    const memory = memoryFs({ 'pipe.md': 'P' })
    const fs = { ...memory, stat: async (path: string) => ({ ...(await memory.stat(path)), isFile: () => false }) }
    const detector = fakeDetector()
    const gateway = createStorageGateway({ root: () => ROOT, detector, fs, poolSize: 4 })

    expect((await gateway.classify(['pipe.md'])).get('pipe.md')).toMatchObject({ isRegular: false })
    await expect(gateway.read('pipe.md', { hydrate: true })).resolves.toEqual({ status: 'unavailable', code: 'NOT_REGULAR' })
    expect(detector.classify).not.toHaveBeenCalled()
    expect(memory.calls.some((call) => call.startsWith('readFile'))).toBe(false)
  })

  it('a hydrate read opens a dataless file once, under a permit, reporting progress; a plain read still refuses it', async () => {
    const fs = memoryFs({ 'cloud.md': 'CC' })
    const gateway = createStorageGateway({ root: () => ROOT, detector: fakeDetector(), fs, poolSize: 4 })
    const progress: unknown[] = []

    await expect(gateway.read('cloud.md')).resolves.toMatchObject({ status: 'dataless' })
    const opened = await gateway.read('cloud.md', { hydrate: true, onProgress: (p) => progress.push(p) })

    expect(opened.status).toBe('ok')
    expect(progress).toEqual([{ state: 'hydrating' }, { state: 'done', bytes: 2 }])
    expect(fs.calls.filter((call) => call.startsWith('readFile'))).toHaveLength(1)
  })

  it('a successful hydrate read forgets the remembered dataless answer, so the next plain read returns the bytes', async () => {
    const fs = memoryFs({ 'cloud.md': 'CC' })
    let local = false
    const detector: DatalessDetector = {
      classify: async (files) => new Map(files.map((file): [string, ContentPresence] => [file.path, local ? 'local' : 'dataless'])),
    }
    const gateway = createStorageGateway({ root: () => ROOT, detector, fs, poolSize: 4 })

    await expect(gateway.read('cloud.md')).resolves.toMatchObject({ status: 'dataless' })
    await expect(gateway.read('cloud.md', { hydrate: true })).resolves.toMatchObject({ status: 'ok' })
    local = true
    const next = await gateway.read('cloud.md')

    expect(next.status).toBe('ok')
    expect(next.status === 'ok' && next.bytes.toString()).toBe('CC')
  })

  it("read returns a local file's bytes and version", async () => {
    const fs = memoryFs({ 'a.md': 'hello' })
    const detector = fakeDetector()
    const gateway = createStorageGateway({ root: () => ROOT, detector, fs, poolSize: 4 })

    const result = await gateway.read('a.md')

    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.bytes.toString('utf8')).toBe('hello')
      expect(result.version).toEqual({ mtimeMs: 1_000, ctimeMs: 1_000, size: 5 })
    }
  })

  it('a burst of reads of uncached files makes at most two probes', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 10; i++) files[`f${i}.md`] = `content${i}`
    const fs = memoryFs(files)

    let releaseFirst!: () => void
    const firstAnswer = new Promise<void>((resolve) => (releaseFirst = resolve))
    const classify = vi.fn(async (probed: readonly FileVersion[]): Promise<Map<string, ContentPresence>> => {
      await firstAnswer
      return new Map(probed.map((file): [string, ContentPresence] => [file.path, 'local']))
    })
    const gateway = createStorageGateway({ root: () => ROOT, detector: { classify }, fs, poolSize: 12 })

    const reads = Array.from({ length: 10 }, (_, i) => gateway.read(`f${i}.md`))
    await flush()

    releaseFirst()
    const results = await Promise.all(reads)

    expect(results.every((result) => result.status === 'ok')).toBe(true)
    expect(classify).toHaveBeenCalledTimes(2)
    expect(classify.mock.calls[0][0]).toHaveLength(1)
    expect(classify.mock.calls[1][0]).toHaveLength(9)
  })

  it('a probe that does not answer in time leaves files unknown and unread', async () => {
    const fs = memoryFs({ 'a.md': 'A', 'b.md': 'B' })
    const classify = vi.fn(() => new Promise<Map<string, ContentPresence>>(() => {}))
    const gateway = createStorageGateway({ root: () => ROOT, detector: { classify }, fs, poolSize: 4 })

    const classifyResult = gateway.classify(['a.md', 'b.md'])
    await vi.advanceTimersByTimeAsync(2_000)
    const classified = await classifyResult
    expect(classified.get('a.md')).toMatchObject({ status: 'unknown' })
    expect(classified.get('b.md')).toMatchObject({ status: 'unknown' })

    const readResult = gateway.read('a.md')
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(readResult).resolves.toEqual({ status: 'degraded' })
    expect(fs.calls).not.toContain('readFile a.md')
  })

  it.each(['throws synchronously', 'rejects'] as const)(
    'a detector whose classify %s on its first call leaves that read unknown and unread, and probes again for the next read',
    async (mode) => {
      const fs = memoryFs({ 'a.md': 'A', 'b.md': 'B' })
      let calls = 0
      const classify = vi.fn((files: readonly FileVersion[]): Promise<Map<string, ContentPresence>> => {
        calls += 1
        if (calls === 1) {
          if (mode === 'throws synchronously') throw new Error('probe crashed')
          return Promise.reject(new Error('probe crashed'))
        }
        return Promise.resolve(new Map(files.map((file): [string, ContentPresence] => [file.path, 'local'])))
      })
      const gateway = createStorageGateway({ root: () => ROOT, detector: { classify }, fs, poolSize: 4 })

      const first = await gateway.read('a.md')
      expect(first).toEqual({ status: 'unknown', version: { mtimeMs: 1_000, ctimeMs: 1_000, size: 1 } })
      expect(fs.calls).not.toContain('readFile a.md')

      // Proves `probing` did not stay stuck true after the first probe failed: the second file still
      // gets its own probe, and that probe succeeds.
      const second = await gateway.read('b.md')
      expect(second).toMatchObject({ status: 'ok' })
      expect(classify).toHaveBeenCalledTimes(2)
    }
  )
})

// ---------------------------------------------------------------------------------------------------
// F — failure classification, memory and sharing
// ---------------------------------------------------------------------------------------------------

describe('failure classification (F1)', () => {
  const table: Array<{ code: string; expected: { status: 'missing' } | { status: 'unavailable'; code: string } }> = [
    { code: 'ENOENT', expected: { status: 'missing' } },
    { code: 'ENOTDIR', expected: { status: 'missing' } },
    { code: 'EACCES', expected: { status: 'unavailable', code: 'EACCES' } },
    { code: 'EPERM', expected: { status: 'unavailable', code: 'EPERM' } },
    { code: 'EIO', expected: { status: 'unavailable', code: 'EIO' } },
    { code: 'ETIMEDOUT', expected: { status: 'unavailable', code: 'ETIMEDOUT' } },
    { code: 'EBUSY', expected: { status: 'unavailable', code: 'EBUSY' } }
  ]

  it.each(table)('a stat failure with code $code classifies as $expected.status', async ({ code, expected }) => {
    const fs = memoryFs({ 'a.md': 'A' })
    fs.fail('stat', 'a.md', code)
    const gateway = createStorageGateway({ root: () => ROOT, detector: fakeDetector(), fs, poolSize: 4 })

    await expect(gateway.read('a.md')).resolves.toEqual(expected)
  })

  it.each(table)('a readFile failure with code $code classifies as $expected.status', async ({ code, expected }) => {
    const fs = memoryFs({ 'a.md': 'A' })
    fs.fail('readFile', 'a.md', code)
    const gateway = createStorageGateway({ root: () => ROOT, detector: fakeDetector(), fs, poolSize: 4 })

    await expect(gateway.read('a.md')).resolves.toEqual(expected)
  })

  it('a failure with no errno code classifies as unavailable UNKNOWN', async () => {
    const fs = memoryFs({ 'a.md': 'A' })
    fs.fail('stat', 'a.md', undefined)
    const gateway = createStorageGateway({ root: () => ROOT, detector: fakeDetector(), fs, poolSize: 4 })

    await expect(gateway.read('a.md')).resolves.toEqual({ status: 'unavailable', code: 'UNKNOWN' })
  })
})

describe('failure memory (F2-F3)', () => {
  it('a read that returns dataless is answered from memory for 60 s, then tried again', async () => {
    const fs = memoryFs({ 'cloud.md': 'C' })
    const detector = fakeDetector()
    const gateway = createStorageGateway({ root: () => ROOT, detector, fs, poolSize: 4 })

    const first = await gateway.read('cloud.md')
    expect(first).toMatchObject({ status: 'dataless' })
    expect(fs.calls.filter((call) => call === 'stat cloud.md')).toHaveLength(1)
    expect(detector.classify).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(59_000)
    const second = await gateway.read('cloud.md')
    expect(second).toEqual(first)
    expect(fs.calls.filter((call) => call === 'stat cloud.md')).toHaveLength(1)
    expect(detector.classify).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1_000) // total 60 s since the first read
    const third = await gateway.read('cloud.md')
    expect(third).toMatchObject({ status: 'dataless' })
    expect(fs.calls.filter((call) => call === 'stat cloud.md')).toHaveLength(2)
  })

  it('a read that returns unknown is answered from memory for 60 s, then tried again', async () => {
    const fs = memoryFs({ 'odd.md': 'O' })
    const detector = fakeDetector()
    const gateway = createStorageGateway({ root: () => ROOT, detector, fs, poolSize: 4 })

    const first = await gateway.read('odd.md')
    expect(first).toMatchObject({ status: 'unknown' })
    expect(fs.calls.filter((call) => call === 'stat odd.md')).toHaveLength(1)
    expect(detector.classify).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(59_000)
    const second = await gateway.read('odd.md')
    expect(second).toEqual(first)
    expect(fs.calls.filter((call) => call === 'stat odd.md')).toHaveLength(1)
    expect(detector.classify).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1_000) // total 60 s since the first read
    const third = await gateway.read('odd.md')
    expect(third).toMatchObject({ status: 'unknown' })
    expect(fs.calls.filter((call) => call === 'stat odd.md')).toHaveLength(2)
  })

  it('a read that returns unavailable is answered from memory for 60 s, then tried again', async () => {
    const fs = memoryFs({ 'a.md': 'A' })
    fs.fail('stat', 'a.md', 'EACCES')
    const detector = fakeDetector()
    const gateway = createStorageGateway({ root: () => ROOT, detector, fs, poolSize: 4 })

    const first = await gateway.read('a.md')
    expect(first).toEqual({ status: 'unavailable', code: 'EACCES' })
    expect(fs.calls.filter((call) => call === 'stat a.md')).toHaveLength(1)
    expect(detector.classify).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(59_000)
    const second = await gateway.read('a.md')
    expect(second).toEqual(first)
    expect(fs.calls.filter((call) => call === 'stat a.md')).toHaveLength(1)
    expect(detector.classify).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1_000) // total 60 s since the first read
    const third = await gateway.read('a.md') // the gate only failed the first stat: this one succeeds
    expect(third).toMatchObject({ status: 'ok' })
    expect(fs.calls.filter((call) => call === 'stat a.md')).toHaveLength(2)
  })

  it('a read that times out is answered from memory for 60 s, then tried again', async () => {
    const fs = memoryFs({ 'a.md': 'A' })
    const heldA = fs.hold('readFile', 'a.md')
    const detector = fakeDetector()
    const gateway = createStorageGateway({ root: () => ROOT, detector, fs, poolSize: 4 })

    const first = gateway.read('a.md')
    await flush()
    await vi.advanceTimersByTimeAsync(5_000) // the content deadline; the readFile stays held throughout
    await expect(first).resolves.toEqual({ status: 'timeout' })
    expect(fs.calls.filter((call) => call === 'stat a.md')).toHaveLength(1)
    expect(detector.classify).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(59_000) // total 64 s: 59 s since the failure was remembered
    const second = await gateway.read('a.md')
    expect(second).toEqual({ status: 'timeout' })
    expect(fs.calls.filter((call) => call === 'stat a.md')).toHaveLength(1)
    expect(detector.classify).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1_000) // total 65 s: 60 s since the failure was remembered
    void gateway.read('a.md')
    await flush()
    expect(fs.calls.filter((call) => call === 'stat a.md')).toHaveLength(2)

    heldA.release()
    await flush()
  })

  it('missing, degraded, aborted and ok are never remembered', async () => {
    const missingFs = memoryFs({})
    const missingGateway = createStorageGateway({ root: () => ROOT, detector: fakeDetector(), fs: missingFs, poolSize: 4 })
    await expect(missingGateway.read('gone.md')).resolves.toEqual({ status: 'missing' })
    await expect(missingGateway.read('gone.md')).resolves.toEqual({ status: 'missing' })
    expect(missingFs.calls.filter((call) => call === 'stat gone.md')).toHaveLength(2)

    const degradedFs = memoryFs({ 'a.md': 'A', 'b.md': 'B' })
    const degradedGateway = createStorageGateway({ root: () => ROOT, detector: fakeDetector(), fs: degradedFs, poolSize: 3 }) // cap 1
    const heldA = degradedFs.hold('readFile', 'a.md')
    void degradedGateway.read('a.md')
    await flush()
    const degradedRead = degradedGateway.read('b.md')
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(degradedRead).resolves.toEqual({ status: 'degraded' })
    heldA.release()
    await flush()
    await expect(degradedGateway.read('b.md')).resolves.toMatchObject({ status: 'ok' })

    const abortedFs = memoryFs({ 'a.md': 'A' })
    const abortedGateway = createStorageGateway({ root: () => ROOT, detector: fakeDetector(), fs: abortedFs, poolSize: 4 })
    const abortedController = new AbortController()
    abortedController.abort()
    await expect(abortedGateway.read('a.md', { signal: abortedController.signal })).resolves.toEqual({ status: 'aborted' })
    await expect(abortedGateway.read('a.md')).resolves.toMatchObject({ status: 'ok' })

    const okFs = memoryFs({ 'a.md': 'A' })
    const okGateway = createStorageGateway({ root: () => ROOT, detector: fakeDetector(), fs: okFs, poolSize: 4 })
    await expect(okGateway.read('a.md')).resolves.toMatchObject({ status: 'ok' })
    okFs.touch('a.md')
    await expect(okGateway.read('a.md')).resolves.toMatchObject({ status: 'ok' })
    expect(okFs.calls.filter((call) => call === 'stat a.md')).toHaveLength(2)
  })
})

describe('sharing (F4-F6)', () => {
  it('concurrent reads of one unchanged file share one readFile', async () => {
    const fs = memoryFs({ 'a.md': 'hello' })
    const gateway = createStorageGateway({ root: () => ROOT, detector: fakeDetector(), fs, poolSize: 6 })

    const heldA = fs.hold('readFile', 'a.md')
    const reads = [gateway.read('a.md'), gateway.read('a.md'), gateway.read('a.md')]
    await flush()
    expect(fs.calls.filter((call) => call === 'readFile a.md')).toHaveLength(1)

    heldA.release()
    const results = await Promise.all(reads)
    for (const result of results) {
      expect(result.status).toBe('ok')
      if (result.status === 'ok') expect(result.bytes.toString('utf8')).toBe('hello')
    }
    expect(fs.calls.filter((call) => call === 'readFile a.md')).toHaveLength(1)

    const later = await gateway.read('a.md')
    expect(later.status).toBe('ok')
    expect(fs.calls.filter((call) => call === 'readFile a.md')).toHaveLength(2)
  })

  it('a shared read still reaches the other callers when the caller that started it aborts', async () => {
    const fs = memoryFs({ 'a.md': 'hello' })
    const gateway = createStorageGateway({ root: () => ROOT, detector: fakeDetector(), fs, poolSize: 6 })

    const heldA = fs.hold('readFile', 'a.md')
    const controller = new AbortController()
    const starter = gateway.read('a.md', { signal: controller.signal })
    await flush()

    const follower = gateway.read('a.md')
    await flush()

    controller.abort()
    await expect(starter).resolves.toEqual({ status: 'aborted' })

    heldA.release()
    const followerResult = await follower
    expect(followerResult.status).toBe('ok')
    if (followerResult.status === 'ok') expect(followerResult.bytes.toString('utf8')).toBe('hello')
  })

  it('a read of a changed file does not join the read of its previous version', async () => {
    const fs = memoryFs({ 'a.md': 'hello' })
    const gateway = createStorageGateway({ root: () => ROOT, detector: fakeDetector(), fs, poolSize: 4 })

    await expect(gateway.read('a.md')).resolves.toMatchObject({ status: 'ok' })
    fs.touch('a.md')
    await expect(gateway.read('a.md')).resolves.toMatchObject({ status: 'ok' })

    expect(fs.calls.filter((call) => call === 'readFile a.md')).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------------------------------
// P — containment
// ---------------------------------------------------------------------------------------------------

describe('containment (P1-P4)', () => {
  it('rejects paths that leave the root before any fs call', async () => {
    const fs = memoryFs({})
    const detector = fakeDetector()
    const gateway = createStorageGateway({ root: () => ROOT, detector, fs, poolSize: 4 })

    for (const path of ['../x.md', join('a', '..', '..', 'x.md'), join(sep, 'etc', 'x.md'), 'x\0.md']) {
      await expect(gateway.read(path)).resolves.toEqual({ status: 'unavailable', code: 'OUTSIDE_ROOT' })
    }
    expect(fs.calls).toEqual([])
    expect(detector.classify).not.toHaveBeenCalled()
  })

  it('refuses to read through a link that leaves the root', async () => {
    vi.useRealTimers()
    const dir = mkdtempSync(join(tmpdir(), 'gateway-p2-'))
    try {
      const root = join(dir, 'root')
      const outside = join(dir, 'outside')
      mkdirSync(root)
      mkdirSync(outside)
      writeFileSync(join(outside, 'secret.md'), 'TOP SECRET')
      symlinkSync(outside, join(root, 'linked'), 'junction')

      const gateway = createStorageGateway({ root: () => root, detector: localDetector(), poolSize: 4 })
      const result = await gateway.read(join('linked', 'secret.md'))

      expect(result).toEqual({ status: 'unavailable', code: 'OUTSIDE_ROOT' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolves the root on every call', async () => {
    const fs = memoryFs({ [join(ROOT, 'a.md')]: 'A', [join(ROOT2, 'b.md')]: 'B' })
    let current = ROOT
    const gateway = createStorageGateway({ root: () => current, detector: fakeDetector(), fs, poolSize: 4 })

    current = ROOT
    const resultA = await gateway.read('a.md')
    expect(resultA.status).toBe('ok')
    if (resultA.status === 'ok') expect(resultA.bytes.toString('utf8')).toBe('A')
    expect(fs.paths).toContain(join(ROOT, 'a.md'))

    // b.md exists only under ROOT2: a gateway that cached root() at construction instead of resolving it
    // on this call would still ask ROOT for it and find nothing there.
    current = ROOT2
    const resultB = await gateway.read('b.md')
    expect(resultB.status).toBe('ok')
    if (resultB.status === 'ok') expect(resultB.bytes.toString('utf8')).toBe('B')
    expect(fs.paths).toContain(join(ROOT2, 'b.md'))
    expect(fs.paths).not.toContain(join(ROOT, 'b.md'))

    // A stale root answering ROOT for 'b.md' is exactly the failure a caching bug would produce: nothing
    // there, not a false 'ok'.
    current = ROOT
    await expect(gateway.read('b.md')).resolves.toEqual({ status: 'missing' })
  })

  it("list returns a directory's entry names; a missing directory is 'missing'", async () => {
    vi.useRealTimers()
    const dir = mkdtempSync(join(tmpdir(), 'gateway-p4-'))
    try {
      writeFileSync(join(dir, 'a.md'), 'A')
      writeFileSync(join(dir, 'b.md'), 'B')
      const gateway = createStorageGateway({ root: () => dir, detector: localDetector(), poolSize: 4 })

      const listed = await gateway.list('.')
      expect(listed.status).toBe('ok')
      if (listed.status === 'ok') expect(new Set(listed.names)).toEqual(new Set(['a.md', 'b.md']))

      await expect(gateway.list('does-not-exist')).resolves.toEqual({ status: 'missing' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------------------------------
// K — real kernel-blocking FIFOs (POSIX only: Windows has no FIFOs)
// ---------------------------------------------------------------------------------------------------

async function releaseUntilSettled(fifos: readonly string[], pending: Promise<unknown>): Promise<void> {
  let settled = false
  void pending.finally(() => {
    settled = true
  })
  while (!settled) {
    for (const fifo of fifos) releaseFifo(fifo)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe.skipIf(process.platform === 'win32')('kernel-blocking pool protection (K0-K2)', () => {
  const pool = threadpoolSize(process.env.UV_THREADPOOL_SIZE)
  let dir: string

  beforeEach(() => {
    vi.useRealTimers()
    dir = mkdtempSync(join(tmpdir(), 'gateway-fifo-'))
  })

  afterEach(() => {
    for (const name of readdirSync(dir)) releaseFifo(join(dir, name))
    rmSync(dir, { recursive: true, force: true })
  })

  it('the fixture is real: pool + 2 direct reads of FIFOs leave dns.lookup waiting', async () => {
    const { readFile } = await import('node:fs/promises')
    const fifos = Array.from({ length: pool + 2 }, (_, i) => join(dir, `direct-${i}`))
    for (const fifo of fifos) createFifo(fifo)

    const reads = Promise.all(fifos.map((fifo) => readFile(fifo)))
    let lookupResolved = false
    const lookupDone = lookup('localhost').then((value) => {
      lookupResolved = true
      return value
    })

    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(lookupResolved).toBe(false) // the pool is fully pinned by direct FIFO reads

    await releaseUntilSettled(fifos, reads)
    await lookupDone
  }, 20_000)

  it('through the gateway, six blocked reads leave dns.lookup, an async write and the event loop responsive', async () => {
    const meetingsRoot = mkdtempSync(join(tmpdir(), 'gateway-fifo-root-'))
    const brainEntities = join(meetingsRoot, '.brain', 'entities', 'person')
    mkdirSync(brainEntities, { recursive: true })

    const fifoPaths = [
      join(meetingsRoot, '2026-01-01_090000-st1-fifo-1.md'),
      join(meetingsRoot, '2026-01-01_090000-st1-fifo-2.md'),
      join(meetingsRoot, '2026-01-01_090000-st1-fifo-3.md'),
      join(meetingsRoot, '2026-01-01_090000-st1-fifo-4.md'),
      join(meetingsRoot, '.brain', 'index.json'),
      join(brainEntities, 'x.json')
    ]
    for (const fifo of fifoPaths) createFifo(fifo)

    try {
      const relPaths = fifoPaths.map((path) => relative(meetingsRoot, path))
      const gateway = createStorageGateway({ root: () => meetingsRoot, detector: localDetector(), poolSize: pool })

      const loop = monitorEventLoopDelay({ resolution: 10 })
      loop.enable()

      const reads = Promise.all(relPaths.map((rel) => gateway.read(rel)))
      await new Promise((resolve) => setTimeout(resolve, 100))

      const writeDir = mkdtempSync(join(tmpdir(), 'gateway-fifo-write-'))
      try {
        const writeStarted = performance.now()
        await writeFile(join(writeDir, 'probe.txt'), 'x')
        expect(performance.now() - writeStarted).toBeLessThan(250)

        const lookupStarted = performance.now()
        await lookup('localhost')
        expect(performance.now() - lookupStarted).toBeLessThan(250)

        expect(loop.percentile(99) / 1e6).toBeLessThan(50)
      } finally {
        loop.disable()
        rmSync(writeDir, { recursive: true, force: true })
      }

      await releaseUntilSettled(fifoPaths, reads)
      const results = await reads
      for (const result of results) {
        expect(result.status).toBe('ok')
        if (result.status === 'ok') expect(result.bytes.length).toBe(0)
      }
    } finally {
      for (const fifo of fifoPaths) releaseFifo(fifo)
      rmSync(meetingsRoot, { recursive: true, force: true })
    }
  }, 20_000)

  it('a FIFO the detector calls dataless is answered at once and never opened', async () => {
    const fifo = join(dir, 'cloud-fifo.md')
    createFifo(fifo)

    const gateway = createStorageGateway({ root: () => dir, detector: datalessDetector(), poolSize: pool })
    const result = await gateway.read('cloud-fifo.md')

    expect(result).toMatchObject({ status: 'dataless' })
    expect(releaseFifo(fifo)).toBe(false) // nobody was ever waiting to open it
  })
})
