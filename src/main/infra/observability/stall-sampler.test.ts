import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { startStallSampler } from './stall-sampler'
import { bundleDir, captureDir, type CaptureOutcome } from './stall-bundle'

const COMMAND = '/x/metis-mac-helper'
const POSIX = process.platform !== 'win32'
const TEST_PID = 4242

function fakeChild(pid = TEST_PID): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess
  Object.defineProperty(child, 'pid', { value: pid, configurable: true })
  Object.defineProperty(child, 'stdout', { value: new PassThrough(), configurable: true })
  child.kill = vi.fn() as unknown as ChildProcess['kill']
  return child
}

/** `ChildProcess['stdout']` is typed as a plain `Readable`, but fakeChild() always backs it with a
 *  `PassThrough`, which is writable too — this seam lets tests push chunks through it. */
function writeStdout(child: ChildProcess, chunk: string): void {
  (child.stdout as unknown as PassThrough).write(chunk)
}

/** Lets pending microtasks (the sampler's internal `collecting` promise chain) settle. */
async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve))
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition never became true')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const MINIMAL_REPORT = [
  'Call graph:',
  '    1 Thread_1: t   DispatchQueue_1: com.apple.main-thread  (serial)',
  '    + 1 main  (in Metis) + 1  [0x1]',
  ''
].join('\n')

describe('startStallSampler', () => {
  let userData: string
  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'metis-stall-sampler-'))
  })
  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
  })

  it('creates captureDir (mode 0700 on POSIX) and spawns the helper with the exact stall-watch arguments', () => {
    const bootId = '11112222-3333-4444-5555-666677778888'
    const child = fakeChild()
    const spawn = vi.fn(() => child)
    const collect = vi.fn(async (): Promise<CaptureOutcome[]> => [])
    startStallSampler({
      command: COMMAND,
      userData,
      bootId,
      aliveIntervalMs: 10_000,
      audit: vi.fn(),
      deps: { spawn: spawn as unknown as typeof nodeSpawn, collect }
    })
    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      COMMAND,
      [
        'stall-watch',
        '--pid',
        String(process.pid),
        '--alive',
        join(userData, 'run-alive.json'),
        '--capture-prefix',
        join(userData, 'diagnostics', 'stalls', 'raw', bootId),
        '--stale-after-ms',
        '20000'
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    )
    if (POSIX) expect(statSync(captureDir(userData)).mode & 0o777).toBe(0o700)
  })

  it("audits the stall-watch helper's spawn and exit", async () => {
    const child = fakeChild(9876)
    const audit = vi.fn()
    const collect = vi.fn(async (): Promise<CaptureOutcome[]> => [])
    startStallSampler({
      command: COMMAND,
      userData,
      bootId: 'this-boot',
      aliveIntervalMs: 10_000,
      audit,
      deps: { spawn: (() => child) as unknown as typeof nodeSpawn, collect }
    })

    // The pgid lookup is asynchronous (M2-0422), so the spawn audit lands after the lookup settles.
    await vi.waitFor(() =>
      expect(audit).toHaveBeenCalledWith('sidecar.spawn', { name: 'stall-watch', pid: 9876, pgid: null })
    )
    child.emit('exit', 0, null)
    await vi.waitFor(() =>
      expect(audit).toHaveBeenCalledWith('sidecar.exit', {
      name: 'stall-watch',
      pid: 9876,
      pgid: null,
      code: 0,
      signal: null,
      uptimeMs: expect.any(Number)
      })
    )
  })

  it("collects once at start, before any stdout line — an outcome for a different bootId is audited under that outcome's own bootId", async () => {
    const child = fakeChild()
    const audit = vi.fn()
    const otherBootOutcome: CaptureOutcome = { kind: 'bundled', bootId: 'previous-boot', stalledMs: 42, bundle: 'b.txt' }
    let resolveCollect: (v: CaptureOutcome[]) => void = () => {}
    const collect = vi.fn(() => new Promise<CaptureOutcome[]>((resolve) => (resolveCollect = resolve)))
    startStallSampler({
      command: COMMAND,
      userData,
      bootId: 'this-boot',
      aliveIntervalMs: 10_000,
      audit,
      deps: { spawn: (() => child) as unknown as typeof nodeSpawn, collect }
    })
    await flush() // the startup collection is scheduled as a microtask, not run synchronously
    expect(collect).toHaveBeenCalledExactlyOnceWith(userData)
    resolveCollect([otherBootOutcome])
    await flush()
    expect(audit).toHaveBeenCalledWith('app.stall.sampled', { bootId: 'previous-boot', stalledMs: 42, bundle: 'b.txt' })
  })

  it("'sampled' split across chunks triggers exactly one collection, and each bundled outcome is audited as app.stall.sampled", async () => {
    const child = fakeChild()
    const audit = vi.fn()
    const outcome: CaptureOutcome = { kind: 'bundled', bootId: 'this-boot', stalledMs: 30_000, bundle: 'b1.txt' }
    const collect = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([outcome])
    startStallSampler({
      command: COMMAND,
      userData,
      bootId: 'this-boot',
      aliveIntervalMs: 10_000,
      audit,
      deps: { spawn: (() => child) as unknown as typeof nodeSpawn, collect }
    })
    await flush()
    writeStdout(child, 'samp')
    writeStdout(child, 'led\n')
    await flush()
    expect(collect).toHaveBeenCalledTimes(2)
    expect(audit).toHaveBeenCalledWith('app.stall.sampled', { bootId: 'this-boot', stalledMs: 30_000, bundle: 'b1.txt' })
  })

  it("'failed' audits app.stall.sample_failed with reason 'sample' under this boot's id, without collecting; unknown lines are ignored", async () => {
    const child = fakeChild()
    const audit = vi.fn()
    const collect = vi.fn().mockResolvedValue([])
    startStallSampler({
      command: COMMAND,
      userData,
      bootId: 'this-boot',
      aliveIntervalMs: 10_000,
      audit,
      deps: { spawn: (() => child) as unknown as typeof nodeSpawn, collect }
    })
    await flush()
    collect.mockClear()
    writeStdout(child, 'garbage\n')
    writeStdout(child, 'failed\n')
    await flush()
    expect(collect).not.toHaveBeenCalled()
    const failures = audit.mock.calls.filter((c) => c[0] === 'app.stall.sample_failed')
    expect(failures).toEqual([['app.stall.sample_failed', { bootId: 'this-boot', reason: 'sample' }]])
  })

  it('a failed collection outcome is audited as app.stall.sample_failed with reason "bundle" under that outcome\'s own bootId', async () => {
    const child = fakeChild()
    const audit = vi.fn()
    const failedOutcome: CaptureOutcome = { kind: 'failed', bootId: 'previous-boot' }
    const collect = vi.fn().mockResolvedValueOnce([failedOutcome])
    startStallSampler({
      command: COMMAND,
      userData,
      bootId: 'this-boot',
      aliveIntervalMs: 10_000,
      audit,
      deps: { spawn: (() => child) as unknown as typeof nodeSpawn, collect }
    })
    await flush()
    expect(audit).toHaveBeenCalledWith('app.stall.sample_failed', { bootId: 'previous-boot', reason: 'bundle' })
  })

  it('serialises collections: a second "sampled" line does not call collect again until the pending collection resolves', async () => {
    const child = fakeChild()
    const audit = vi.fn()
    let resolveFirst: (v: CaptureOutcome[]) => void = () => {}
    const collect = vi
      .fn()
      .mockImplementationOnce(() => new Promise<CaptureOutcome[]>((resolve) => (resolveFirst = resolve)))
      .mockResolvedValue([])
    startStallSampler({
      command: COMMAND,
      userData,
      bootId: 'this-boot',
      aliveIntervalMs: 10_000,
      audit,
      deps: { spawn: (() => child) as unknown as typeof nodeSpawn, collect }
    })
    await flush()
    expect(collect).toHaveBeenCalledTimes(1) // the startup collection, still pending
    writeStdout(child, 'sampled\n')
    await flush()
    expect(collect).toHaveBeenCalledTimes(1) // queued behind the pending one, not run yet
    resolveFirst([])
    await flush()
    expect(collect).toHaveBeenCalledTimes(2)
  })

  it('audits reason "watcher" exactly once whether the helper emits error-then-close, or close alone, before stop()', async () => {
    const scenarios: Array<(c: ChildProcess) => void> = [
      (c) => {
        c.emit('error', new Error('spawn failed'))
        c.emit('close', 1, null)
      },
      (c) => {
        c.emit('close', 1, null)
      }
    ]
    for (const emit of scenarios) {
      const child = fakeChild()
      const audit = vi.fn()
      const collect = vi.fn().mockResolvedValue([])
      startStallSampler({
        command: COMMAND,
        userData,
        bootId: 'this-boot',
        aliveIntervalMs: 10_000,
        audit,
        deps: { spawn: (() => child) as unknown as typeof nodeSpawn, collect }
      })
      await flush()
      audit.mockClear()
      emit(child)
      await flush()
      const watcherFailures = audit.mock.calls.filter((c) => c[0] === 'app.stall.sample_failed' && (c[1] as { reason?: string })?.reason === 'watcher')
      expect(watcherFailures).toHaveLength(1)
    }
  })

  it('spawns nothing and audits reason "watcher" once when userData is a file (mkdir fails)', async () => {
    const fileUserData = join(userData, 'not-a-dir')
    writeFileSync(fileUserData, 'x')
    const audit = vi.fn()
    const spawn = vi.fn()
    const collect = vi.fn().mockResolvedValue([])
    startStallSampler({
      command: COMMAND,
      userData: fileUserData,
      bootId: 'this-boot',
      aliveIntervalMs: 10_000,
      audit,
      deps: { spawn: spawn as unknown as typeof nodeSpawn, collect }
    })
    await flush()
    expect(spawn).not.toHaveBeenCalled()
    const watcherFailures = audit.mock.calls.filter((c) => c[0] === 'app.stall.sample_failed' && (c[1] as { reason?: string })?.reason === 'watcher')
    expect(watcherFailures).toHaveLength(1)
  })

  it("stop() kills the helper once even when called twice, and a later close or stdout line audits nothing", async () => {
    const child = fakeChild()
    const audit = vi.fn()
    const collect = vi.fn().mockResolvedValue([])
    const sampler = startStallSampler({
      command: COMMAND,
      userData,
      bootId: 'this-boot',
      aliveIntervalMs: 10_000,
      audit,
      deps: { spawn: (() => child) as unknown as typeof nodeSpawn, collect }
    })
    await flush()
    sampler.stop()
    sampler.stop()
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    audit.mockClear()
    child.emit('close', null, 'SIGKILL')
    writeStdout(child, 'failed\n')
    await flush()
    expect(audit).not.toHaveBeenCalled()
  })

  it('end to end: with the real collector, a captured sample becomes one bundle and one app.stall.sampled event naming it', async () => {
    const bootId = '99998888-7777-6666-5555-444433332222'
    const child = fakeChild()
    const audit = vi.fn()
    startStallSampler({
      command: COMMAND,
      userData,
      bootId,
      aliveIntervalMs: 10_000,
      audit,
      deps: { spawn: (() => child) as unknown as typeof nodeSpawn }
    })
    await flush()
    const capture = join(captureDir(userData), `${bootId}.1790000000000.12345.sample`)
    writeFileSync(capture, MINIMAL_REPORT)
    writeStdout(child, 'sampled\n')
    const bundle = `${bootId}.1790000000000.12345.txt`
    await waitFor(() => audit.mock.calls.some(([event]) => event === 'app.stall.sampled'))
    expect(existsSync(join(bundleDir(userData), bundle))).toBe(true)
    expect(audit).toHaveBeenCalledWith('app.stall.sampled', { bootId, stalledMs: 12345, bundle })
  })
})
