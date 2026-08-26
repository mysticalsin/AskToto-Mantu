/**
 * local-runtime.concurrency.test.ts — F1 (startup race) + F2 (model switch), proven against a fully faked
 * `child_process.spawn` + global `fetch` so the timing of "spawn → listening-on log line → health 200" is
 * fully controllable and deterministic. Lives in its own file (not local-runtime.test.ts) because it mocks
 * `node:child_process` module-wide, which would otherwise break local-runtime.test.ts's real-binary
 * integration block.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'node:path'
import { LOCAL_MODELS, spawnProfileFor } from './local-models'

// MQA-248: these literals used to be `{ gguf, mmproj }` alone, missing the ctxSize/parallel/gpuLayers that
// ModelPaths gained when the sidecar learned to size itself to the machine. That is the identical defect
// that shipped `-c undefined` into a tagged release from local-runtime.test.ts — the same omission, in a
// sibling file, invisible for the same two reasons: both tsconfigs exclude **/*.test.ts, so no test file is
// typechecked, and these tests mock the spawn so nothing ever read the bad value at runtime.
//
// Derived from the real profile rather than hardcoded, so it cannot drift from production again.
const SPAWN_PROFILE = { ...spawnProfileFor(LOCAL_MODELS[LOCAL_MODELS.length - 1], 16, 8), vision: false }

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/tmp' } }))
vi.mock('../logger', () => ({ mainLog: { info: vi.fn(), warn: vi.fn() }, auditLog: vi.fn() }))

// The fake binary must "exist" so start() never short-circuits on the missing-binary path — only the
// spawn/health timing matters for these tests.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, existsSync: () => true }
})

interface FakeProc {
  stdout: import('node:events').EventEmitter
  stderr: import('node:events').EventEmitter
  killed: boolean
  kill: ReturnType<typeof vi.fn>
  emit: (event: string, ...args: unknown[]) => boolean
  once: (event: string, listener: (...args: unknown[]) => void) => unknown
  on: (event: string, listener: (...args: unknown[]) => void) => unknown
}

const spawnState = vi.hoisted(() => ({
  procs: [] as FakeProc[],
  calls: [] as { path: string; args: string[] }[]
}))

vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events')
  const spawn = vi.fn((path: string, args: string[]) => {
    const proc = new EventEmitter() as unknown as FakeProc
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.killed = false
    proc.kill = vi.fn(() => {
      if (proc.killed) return
      proc.killed = true
      queueMicrotask(() => proc.emit('exit', null, 'SIGKILL'))
    })
    spawnState.procs.push(proc)
    spawnState.calls.push({ path, args })
    return proc
  })
  return { spawn }
})

import { start, stop, isRunning, baseURL, beginStream, endStream, getState } from './local-runtime'
import { auditLog, mainLog } from '../logger'

type FetchImpl = (...args: unknown[]) => Promise<{ status: number }>
let fetchImpl: FetchImpl = async () => ({ status: 200 })

beforeEach(() => {
  vi.clearAllMocks()
  spawnState.procs = []
  spawnState.calls = []
  fetchImpl = async () => ({ status: 200 })
  vi.stubGlobal('fetch', (...args: unknown[]) => fetchImpl(...args))
})

afterEach(() => {
  stop()
  vi.unstubAllGlobals()
})

function emitListening(procIndex: number, port: number): void {
  spawnState.procs[procIndex].stdout.emit('data', Buffer.from(`0.00.787.103 I srv listening on http://127.0.0.1:${port}\n`))
}

async function waitUntil(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out')
    await new Promise((r) => setTimeout(r, 1))
  }
}

describe('F1 — concurrent start() calls share one in-flight start', () => {
  it('a second concurrent start() call for the SAME model spawns only once, and neither caller resolves before health actually completes', async () => {
    let healthSettled = false
    fetchImpl = () =>
      new Promise((resolve) => {
        setTimeout(() => {
          healthSettled = true
          resolve({ status: 200 })
        }, 15)
      })

    const paths = { gguf: '/m/a.gguf', mmproj: '/m/a.mmproj', ...SPAWN_PROFILE }
    const p1 = start(paths, 'mac')
    const p2 = start(paths, 'mac') // second caller arrives while state === 'starting'

    // Only ONE spawn for two concurrent callers targeting the same model — no duplicate process.
    expect(spawnState.calls.length).toBe(1)

    emitListening(0, 55123) // the sidecar "prints" its listening line so pollHealth can begin

    let p1ResolvedAfterHealth = false
    let p2ResolvedAfterHealth = false
    let p2BaseURLReachable = false
    p1.then(() => {
      p1ResolvedAfterHealth = healthSettled
    })
    p2.then(() => {
      p2ResolvedAfterHealth = healthSettled
      try {
        baseURL()
        p2BaseURLReachable = true
      } catch {
        p2BaseURLReachable = false
      }
    })

    await Promise.all([p1, p2])

    // FAILS on the old code: the old start() returned immediately for a caller that saw state==='starting',
    // so the second caller's promise would resolve on the next microtask — long before this 15ms health
    // delay settles, and before `port` was ever set (baseURL() would throw).
    expect(p1ResolvedAfterHealth).toBe(true)
    expect(p2ResolvedAfterHealth).toBe(true)
    expect(p2BaseURLReachable).toBe(true)
    expect(isRunning()).toBe(true)
    expect(spawnState.calls.length).toBe(1) // still only one spawn
  })
})

describe('quit cancellation — Windows fallback', () => {
  it('stop() during the first Windows candidate cancels startup instead of spawning the CPU fallback', async () => {
    const paths = { gguf: '/m/a.gguf', mmproj: '/m/a.mmproj', ...SPAWN_PROFILE }
    let outcome: 'resolved' | 'rejected' | undefined

    void start(paths, 'win').then(
      () => {
        outcome = 'resolved'
      },
      () => {
        outcome = 'rejected'
      }
    )
    expect(spawnState.calls).toHaveLength(1)
    expect(spawnState.calls[0].path).toContain(join('win', 'vulkan', 'llama-server.exe'))

    // Reproduce app will-quit while Vulkan is still loading. The fake kill emits its exit event on the
    // next microtask, exactly the window where the old candidate loop mistook shutdown for a Vulkan
    // startup failure and launched the CPU fallback after stop() had already returned.
    stop()
    await waitUntil(() => outcome !== undefined || spawnState.calls.length > 1)

    expect(outcome).toBe('rejected')
    expect(spawnState.calls).toHaveLength(1)
    expect(spawnState.procs[0].killed).toBe(true)
    expect(getState()).toBe('stopped')
    expect(isRunning()).toBe(false)
  })

  it('a detached old start cannot overwrite a newer generation port with a delayed listening line', async () => {
    const pathsA = { gguf: '/m/a.gguf', mmproj: '/m/a.mmproj', ...SPAWN_PROFILE }
    const pathsB = { gguf: '/m/b.gguf', mmproj: '/m/b.mmproj', ...SPAWN_PROFILE }
    let outcomeA: 'resolved' | 'rejected' | undefined

    void start(pathsA, 'mac').then(
      () => {
        outcomeA = 'resolved'
      },
      () => {
        outcomeA = 'rejected'
      }
    )
    const procA = spawnState.procs[0]
    // Hold A's OS exit notification so a new generation can become healthy first, then simulate the
    // buffered stdout line from A arriving late after it was detached by stop().
    procA.kill = vi.fn(() => {
      procA.killed = true
    })
    stop()

    const startB = start(pathsB, 'mac')
    await waitUntil(() => spawnState.calls.length === 2)
    emitListening(1, 55902)
    await startB
    expect(baseURL()).toBe('http://127.0.0.1:55902/v1')

    emitListening(0, 55901)
    await waitUntil(() => outcomeA !== undefined)

    expect(outcomeA).toBe('rejected')
    expect(isRunning()).toBe(true)
    expect(baseURL()).toBe('http://127.0.0.1:55902/v1')
    stop()
    expect(spawnState.procs[1].kill).toHaveBeenCalledWith('SIGKILL')
  })
})

describe('F2 — model switch', () => {
  it('starting a DIFFERENT model while one is running stops the old sidecar and spawns the new model', async () => {
    const pathsA = { gguf: '/m/a.gguf', mmproj: '/m/a.mmproj', ...SPAWN_PROFILE }
    const pathsB = { gguf: '/m/b.gguf', mmproj: '/m/b.mmproj', ...SPAWN_PROFILE }

    const p1 = start(pathsA, 'mac')
    emitListening(0, 55201)
    await p1
    expect(isRunning()).toBe(true)
    const procA = spawnState.procs[0]
    expect(procA.killed).toBe(false)

    const p2 = start(pathsB, 'mac')
    await waitUntil(() => spawnState.calls.length === 2)
    emitListening(1, 55202)
    await p2

    expect(procA.kill).toHaveBeenCalledWith('SIGKILL')
    expect(procA.killed).toBe(true)
    expect(spawnState.calls[1].args).toContain('/m/b.gguf')
    expect(isRunning()).toBe(true)
  })

  it('calling start() again with the SAME model while running is a no-op — no restart, no new spawn', async () => {
    const pathsA = { gguf: '/m/a.gguf', mmproj: '/m/a.mmproj', ...SPAWN_PROFILE }
    const p1 = start(pathsA, 'mac')
    emitListening(0, 55301)
    await p1
    const procA = spawnState.procs[0]

    await start(pathsA, 'mac') // same model, already running

    expect(spawnState.calls.length).toBe(1) // no second spawn
    expect(procA.kill).not.toHaveBeenCalled()
    expect(isRunning()).toBe(true)
  })

  it('a switch requested while the FIRST model is still starting awaits it, then restarts with the new model', async () => {
    let releaseHealthA: () => void = () => {}
    fetchImpl = () =>
      new Promise((resolve) => {
        releaseHealthA = () => resolve({ status: 200 })
      })

    const pathsA = { gguf: '/m/a.gguf', mmproj: '/m/a.mmproj', ...SPAWN_PROFILE }
    const pathsB = { gguf: '/m/b.gguf', mmproj: '/m/b.mmproj', ...SPAWN_PROFILE }

    const p1 = start(pathsA, 'mac') // still "starting" — health never resolves until released below
    emitListening(0, 55401)

    const p2 = start(pathsB, 'mac') // wants a DIFFERENT model while the first is still starting

    // p2 must not have spawned B yet — it's awaiting A's in-flight start first.
    expect(spawnState.calls.length).toBe(1)

    fetchImpl = async () => ({ status: 200 }) // B's own health check, once it spawns, should resolve fast
    releaseHealthA() // let A's health complete
    await p1
    // NOTE: by the time p1 settles, p2's queued continuation (awaiting the SAME in-flight promise) may
    // already have run too and kicked off the switch to B — so state here can be 'running' (A) or already
    // 'starting' (B); either is a valid interleaving. What must hold is the end state once p2 also settles.

    await waitUntil(() => spawnState.calls.length === 2) // B's switch-spawn happens once A settles
    emitListening(1, 55402)
    await p2

    expect(spawnState.calls[1].args).toContain('/m/b.gguf')
    expect(spawnState.procs[0].killed).toBe(true) // A was killed once the switch happened
    expect(isRunning()).toBe(true)
  })
})

describe('switch-kill hardening — model switch defers instead of killing an active stream', () => {
  afterEach(() => {
    // Drain any stream left open by a test that intentionally never called endStream() — stop()'s own
    // afterEach hook above doesn't know about activeStreamCount, and a leaked count would spill into the
    // next test's waitForDrain() as a permanently-blocked switch.
    endStream()
  })

  it('does NOT kill the running sidecar while a stream is active — defers until the stream ends, then switches', async () => {
    const pathsA = { gguf: '/m/a.gguf', mmproj: '/m/a.mmproj', ...SPAWN_PROFILE }
    const pathsB = { gguf: '/m/b.gguf', mmproj: '/m/b.mmproj', ...SPAWN_PROFILE }

    const p1 = start(pathsA, 'mac')
    emitListening(0, 55601)
    await p1
    const procA = spawnState.procs[0]

    beginStream() // simulates an in-flight suggest/summary/vision request actively streaming from A

    const p2 = start(pathsB, 'mac') // Settings 'Use this model' -> next local request requests a switch to B

    // Give the deferred branch several microtask turns to (not) act while the stream is still open.
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(procA.kill).not.toHaveBeenCalled()
    expect(spawnState.calls.length).toBe(1) // B has not spawned — the switch is deferred, not abandoned
    expect(isRunning()).toBe(true)
    expect(baseURL()).toBe('http://127.0.0.1:55601/v1') // still A — the in-flight response can keep streaming

    endStream() // the in-flight request finishes (onDone/onError/abort)

    await waitUntil(() => spawnState.calls.length === 2) // NOW the deferred switch proceeds
    emitListening(1, 55602)
    await p2

    expect(procA.kill).toHaveBeenCalledWith('SIGKILL')
    expect(spawnState.calls[1].args).toContain('/m/b.gguf')
    expect(isRunning()).toBe(true)
    expect(baseURL()).toBe('http://127.0.0.1:55602/v1')
    expect(mainLog.info).toHaveBeenCalledWith(
      expect.stringMatching(/switch deferred/),
      expect.objectContaining({ activeStreamCount: 1 })
    )
    // The eventual switch itself still fires the same audit event as an unconstrained switch always did.
    expect(auditLog).toHaveBeenCalledWith('local.runtime.stop', { reason: 'model_switch' })
  })

  it('a caller re-requesting the SAME (already-running) model while a stream is active resolves immediately — no deferral needed', async () => {
    const pathsA = { gguf: '/m/a.gguf', mmproj: '/m/a.mmproj', ...SPAWN_PROFILE }
    const p1 = start(pathsA, 'mac')
    emitListening(0, 55701)
    await p1
    const procA = spawnState.procs[0]

    beginStream()
    await start(pathsA, 'mac') // same model — samePaths() short-circuits before the activeStreamCount check
    expect(procA.kill).not.toHaveBeenCalled()
    expect(spawnState.calls.length).toBe(1)
    endStream()
  })

  it('switches immediately (baseline unaffected) when no stream is active — activeStreamCount defaults to zero', async () => {
    const pathsA = { gguf: '/m/a.gguf', mmproj: '/m/a.mmproj', ...SPAWN_PROFILE }
    const pathsB = { gguf: '/m/b.gguf', mmproj: '/m/b.mmproj', ...SPAWN_PROFILE }
    const p1 = start(pathsA, 'mac')
    emitListening(0, 55801)
    await p1
    const procA = spawnState.procs[0]

    const p2 = start(pathsB, 'mac')
    await waitUntil(() => spawnState.calls.length === 2)
    emitListening(1, 55802)
    await p2

    expect(procA.kill).toHaveBeenCalledWith('SIGKILL')
    expect(isRunning()).toBe(true)
  })
})

describe('G1 — exit handler generation guard', () => {
  it('a stale exit event from the OLD sidecar, arriving AFTER a switch to a NEW one is already healthy, does not clobber the new instance, fire a crash audit, or trigger an auto-restart — and will-quit-style stop() still kills the NEW instance', async () => {
    const pathsA = { gguf: '/m/a.gguf', mmproj: '/m/a.mmproj', ...SPAWN_PROFILE }
    const pathsB = { gguf: '/m/b.gguf', mmproj: '/m/b.mmproj', ...SPAWN_PROFILE }

    const p1 = start(pathsA, 'mac')
    emitListening(0, 55501)
    await p1
    const procA = spawnState.procs[0]

    // Reproduce the real-world race deterministically: the OS-level 'exit' event for a SIGKILL'd process
    // can land on a LATER tick than the kill() call itself. Override the mock's auto-fire-on-kill so we
    // control exactly WHEN A's exit event arrives — specifically, after B is already confirmed healthy —
    // instead of relying on however fast the queued microtask from kill() happens to resolve.
    procA.kill = vi.fn(() => {
      procA.killed = true
    })

    const p2 = start(pathsB, 'mac')
    await waitUntil(() => spawnState.calls.length === 2)
    emitListening(1, 55502)
    await p2
    expect(isRunning()).toBe(true)
    expect(baseURL()).toBe('http://127.0.0.1:55502/v1')

    // A's exit event finally arrives, well after the switch to B completed and B is healthy/running.
    procA.emit('exit', null, 'SIGKILL')
    await Promise.resolve()
    await Promise.resolve()

    // FAILS on the old code: the unconditional exit handler would see state === 'running' (true, for B)
    // and treat A's stale exit as B's crash — nulling child/port (orphaning B, breaking baseURL()),
    // flipping state to 'stopped', firing a local.runtime.crash audit, and auto-restarting a THIRD sidecar
    // for a switch that had already succeeded.
    expect(isRunning()).toBe(true)
    expect(baseURL()).toBe('http://127.0.0.1:55502/v1') // still B's port — untouched by A's stale exit
    expect(auditLog).not.toHaveBeenCalledWith('local.runtime.crash', expect.anything())
    expect(spawnState.calls.length).toBe(2) // no auto-restart spawn triggered by the stale exit

    // will-quit's stop() must still kill the sidecar that's actually running (B), not silently no-op
    // because A's stale exit nulled the module's `child` reference out from under it.
    stop()
    expect(spawnState.procs[1].kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('a proc that dies BEFORE becoming healthy still rejects start() even though it is (trivially) still the current child — the guard only skips a proc that is no longer current', async () => {
    const paths = { gguf: '/m/dies-early.gguf', mmproj: '/m/dies-early.mmproj', ...SPAWN_PROFILE }
    const p = start(paths, 'mac')
    await waitUntil(() => spawnState.calls.length === 1)
    const proc = spawnState.procs[0]
    // Never emits a "listening on" line — dies outright before health polling can even begin.
    proc.emit('exit', 1, null)

    await expect(p).rejects.toThrow(/exited before becoming healthy/)
  })
})
