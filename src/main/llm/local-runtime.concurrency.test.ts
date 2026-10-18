/**
 * local-runtime.concurrency.test.ts — F1 (startup race) + F2 (model switch), proven against a fully faked
 * `child_process.spawn` + global `fetch` so the timing of "spawn → listening-on log line → health 200" is
 * fully controllable and deterministic. Lives in its own file (not local-runtime.test.ts) because it mocks
 * `node:child_process` module-wide, which would otherwise break local-runtime.test.ts's real-binary
 * integration block.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { setImmediate as yieldImmediate } from 'node:timers/promises'
import { LOCAL_MODELS, spawnProfileFor } from './local-models'
import type { PackageRuntimeContract } from '../features/components/speech-pack/package-contract'
import { configurePackageRuntimeContractProvider } from '../features/components/speech-pack/package-runtime-state'

// MQA-248: these literals used to be `{ gguf, mmproj }` alone, missing the ctxSize/parallel/gpuLayers that
// ModelPaths gained when the sidecar learned to size itself to the machine. That is the identical defect
// that shipped `-c undefined` into a tagged release from local-runtime.test.ts — the same omission, in a
// sibling file, invisible for the same two reasons: both tsconfigs exclude **/*.test.ts, so no test file is
// typechecked, and these tests mock the spawn so nothing ever read the bad value at runtime.
//
// Derived from the real profile rather than hardcoded, so it cannot drift from production again.
const SPAWN_PROFILE = { ...spawnProfileFor(LOCAL_MODELS[LOCAL_MODELS.length - 1], 16, 8), vision: false }
// Spawn and file existence are mocked; this unique fixture namespace needs no on-disk directory.
const PACKAGED_RESOURCES = join(tmpdir(), `metis-runtime-concurrency-${randomUUID()}`)
let originalResourcesPath: PropertyDescriptor | undefined

const electron = vi.hoisted(() => ({ app: { isPackaged: false, getPath: () => '/tmp' } }))
vi.mock('electron', () => electron)
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
  calls: [] as { path: string; args: string[] }[],
  observers: [] as (() => void)[]
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
    for (const observe of [...spawnState.observers]) observe()
    return proc
  })
  return { spawn }
})

import { start, stop, isRunning, baseURL, beginStream, endStream, getState } from './local-runtime'
import { auditLog, mainLog } from '../logger'

type FetchImpl = (...args: unknown[]) => Promise<{ status: number }>
let fetchImpl: FetchImpl = async () => ({ status: 200 })
const developmentRuntime: PackageRuntimeContract = { status: 'development', profile: 'development', inventory: null }
const fullRuntime: PackageRuntimeContract = { status: 'legacy-full', profile: 'full', inventory: null }
const invalidRuntime: PackageRuntimeContract = {
  status: 'invalid',
  reason: 'inventory-invalid',
  profile: null,
  inventory: null
}
let runtimeContract: Promise<PackageRuntimeContract> = Promise.resolve(developmentRuntime)
// The configured provider is one-shot; retain its identity and reset only its per-test result.
const runtimeContractProvider = vi.fn(() => runtimeContract)

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function heldRuntimeAuthority() {
  const authority = deferred<PackageRuntimeContract>()
  runtimeContract = authority.promise
  electron.app.isPackaged = true
  return authority
}

/** A regression that spawns instead of rejecting fails on that actual spawn, without waiting for health timeout. */
async function expectRefusalBeforeSpawn(pending: Promise<void>, message: RegExp): Promise<void> {
  const spawned = deferred<{ kind: 'spawned' }>()
  const observe = () => spawned.resolve({ kind: 'spawned' })
  spawnState.observers.push(observe)
  try {
    const outcome = await Promise.race([
      spawned.promise,
      pending.then(
        () => ({ kind: 'resolved' as const }),
        (error: unknown) => ({ kind: 'rejected' as const, error })
      )
    ])
    expect(outcome.kind).toBe('rejected')
    if (outcome.kind === 'rejected') expect(outcome.error).toMatchObject({ message: expect.stringMatching(message) })
  } finally {
    spawnState.observers = spawnState.observers.filter((item) => item !== observe)
  }
}

beforeEach(() => {
  originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: PACKAGED_RESOURCES })
  vi.clearAllMocks()
  spawnState.procs = []
  spawnState.calls = []
  spawnState.observers = []
  electron.app.isPackaged = false
  runtimeContract = Promise.resolve(developmentRuntime)
  configurePackageRuntimeContractProvider(runtimeContractProvider)
  fetchImpl = async () => ({ status: 200 })
  vi.stubGlobal(
    'fetch',
    vi.fn((...args: unknown[]) => fetchImpl(...args))
  )
})

afterEach(() => {
  try {
    stop()
  } finally {
    if (originalResourcesPath) Object.defineProperty(process, 'resourcesPath', originalResourcesPath)
    else Reflect.deleteProperty(process, 'resourcesPath')
    vi.unstubAllGlobals()
  }
})

async function emitListening(procIndex: number, port: number): Promise<void> {
  await waitUntil(() => spawnState.procs[procIndex] !== undefined)
  spawnState.procs[procIndex].stdout.emit(
    'data',
    Buffer.from(`0.00.787.103 I srv listening on http://127.0.0.1:${port}\n`)
  )
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

    await waitUntil(() => spawnState.calls.length >= 1)
    // Only ONE spawn for two concurrent callers targeting the same model — no duplicate process.
    expect(spawnState.calls.length).toBe(1)

    await emitListening(0, 55123) // the sidecar "prints" its listening line so pollHealth can begin

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
  it('an immediate stop cancels a request still held by real package authority before any spawn', async () => {
    const authority = heldRuntimeAuthority()
    const paths = { gguf: '/m/a.gguf', mmproj: '/m/a.mmproj', ...SPAWN_PROFILE }
    const pending = start(paths, 'win')
    const refused = expectRefusalBeforeSpawn(pending, /start cancelled/)
    try {
      // No admission await before stop: authority is genuinely held and neither candidate exists.
      expect(runtimeContractProvider).toHaveBeenCalledTimes(1)
      expect(spawnState.calls).toHaveLength(0)
      expect(stop()).toBeUndefined()
      expect(getState()).toBe('stopped')
      authority.resolve(fullRuntime)
      await refused
      expect(spawnState.calls).toHaveLength(0)
      expect(fetch).not.toHaveBeenCalled()
      expect(isRunning()).toBe(false)
      expect(getState()).toBe('stopped')
      expect(() => baseURL()).toThrow(/not running/)
    } finally {
      stop()
      authority.resolve(invalidRuntime)
      await pending.catch(() => {})
    }
  })

  it('a stopped held request cannot replace or kill a newer healthy sidecar when authority later allows it', async () => {
    const authority = heldRuntimeAuthority()
    const old = start({ gguf: '/m/old.gguf', mmproj: '/m/old.mmproj', ...SPAWN_PROFILE }, 'win')
    void old.catch(() => {})
    let fresh: Promise<void> | undefined
    try {
      expect(runtimeContractProvider).toHaveBeenCalledTimes(1)
      expect(spawnState.calls).toHaveLength(0)
      stop()
      runtimeContract = Promise.resolve(fullRuntime)
      fresh = start({ gguf: '/m/fresh.gguf', mmproj: '/m/fresh.mmproj', ...SPAWN_PROFILE }, 'mac')
      await emitListening(0, 55911)
      await fresh
      expect(spawnState.calls[0].path).toBe(join(PACKAGED_RESOURCES, 'llama', 'mac', process.arch, 'llama-server'))
      const refused = expectRefusalBeforeSpawn(old, /start cancelled/)
      authority.resolve(fullRuntime)
      await refused
      expect(spawnState.calls).toHaveLength(1)
      expect(spawnState.calls[0].args).toContain('/m/fresh.gguf')
      expect(spawnState.procs[0].kill).not.toHaveBeenCalled()
      expect(isRunning()).toBe(true)
      expect(baseURL()).toBe('http://127.0.0.1:55911/v1')
    } finally {
      stop()
      authority.resolve(invalidRuntime)
      await Promise.allSettled([old, ...(fresh ? [fresh] : [])])
    }
  })

  it('keeps real package refusal ahead of spawn when held authority denies the runtime', async () => {
    const authority = heldRuntimeAuthority()
    const pending = start({ gguf: '/m/a.gguf', mmproj: '/m/a.mmproj', ...SPAWN_PROFILE }, 'mac')
    const refused = expectRefusalBeforeSpawn(pending, /optional local LLM runtime is not configured/)
    try {
      expect(runtimeContractProvider).toHaveBeenCalledTimes(1)
      authority.resolve(invalidRuntime)
      await refused
      expect(spawnState.calls).toHaveLength(0)
      expect(fetch).not.toHaveBeenCalled()
      expect(getState()).toBe('stopped')
    } finally {
      stop()
      authority.resolve(invalidRuntime)
      await pending.catch(() => {})
    }
  })

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
    await waitUntil(() => spawnState.calls.length >= 1)
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
    await waitUntil(() => spawnState.procs[0] !== undefined)
    const procA = spawnState.procs[0]
    // Hold A's OS exit notification so a new generation can become healthy first, then simulate the
    // buffered stdout line from A arriving late after it was detached by stop().
    procA.kill = vi.fn(() => {
      procA.killed = true
    })
    stop()

    const startB = start(pathsB, 'mac')
    await waitUntil(() => spawnState.calls.length === 2)
    await emitListening(1, 55902)
    await startB
    expect(baseURL()).toBe('http://127.0.0.1:55902/v1')

    await emitListening(0, 55901)
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
    await emitListening(0, 55201)
    await p1
    expect(isRunning()).toBe(true)
    const procA = spawnState.procs[0]
    expect(procA.killed).toBe(false)

    const p2 = start(pathsB, 'mac')
    await waitUntil(() => spawnState.calls.length === 2)
    await emitListening(1, 55202)
    await p2

    expect(procA.kill).toHaveBeenCalledWith('SIGKILL')
    expect(procA.killed).toBe(true)
    expect(spawnState.calls[1].args).toContain('/m/b.gguf')
    expect(isRunning()).toBe(true)
  })

  it('calling start() again with the SAME model while running is a no-op — no restart, no new spawn', async () => {
    const pathsA = { gguf: '/m/a.gguf', mmproj: '/m/a.mmproj', ...SPAWN_PROFILE }
    const p1 = start(pathsA, 'mac')
    await emitListening(0, 55301)
    await p1
    const procA = spawnState.procs[0]

    await start(pathsA, 'mac') // same model, already running

    expect(spawnState.calls.length).toBe(1) // no second spawn
    expect(procA.kill).not.toHaveBeenCalled()
    expect(isRunning()).toBe(true)
  })

  it('a switch requested while the FIRST model is still starting awaits it, then restarts with the new model', async () => {
    let releaseHealthA: (() => void) | undefined
    fetchImpl = () =>
      new Promise((resolve) => {
        releaseHealthA = () => resolve({ status: 200 })
      })

    const pathsA = { gguf: '/m/a.gguf', mmproj: '/m/a.mmproj', ...SPAWN_PROFILE }
    const pathsB = { gguf: '/m/b.gguf', mmproj: '/m/b.mmproj', ...SPAWN_PROFILE }

    const p1 = start(pathsA, 'mac') // still "starting" — health never resolves until released below
    await emitListening(0, 55401)

    const p2 = start(pathsB, 'mac') // wants a DIFFERENT model while the first is still starting

    await waitUntil(() => releaseHealthA !== undefined)
    // p2 must not have spawned B yet — it's awaiting A's in-flight start first.
    expect(spawnState.calls.length).toBe(1)

    fetchImpl = async () => ({ status: 200 }) // B's own health check, once it spawns, should resolve fast
    releaseHealthA!() // let A's health complete
    await p1
    // NOTE: by the time p1 settles, p2's queued continuation (awaiting the SAME in-flight promise) may
    // already have run too and kicked off the switch to B — so state here can be 'running' (A) or already
    // 'starting' (B); either is a valid interleaving. What must hold is the end state once p2 also settles.

    await waitUntil(() => spawnState.calls.length === 2) // B's switch-spawn happens once A settles
    await emitListening(1, 55402)
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

  it('a switch held by an active stream stays cancelled after stop and the later stream drain', async () => {
    runtimeContract = Promise.resolve(fullRuntime)
    electron.app.isPackaged = true
    const first = start({ gguf: '/m/a.gguf', mmproj: '/m/a.mmproj', ...SPAWN_PROFILE }, 'mac')
    let switching: Promise<void> | undefined
    try {
      await emitListening(0, 55921)
      await first
      const procA = spawnState.procs[0]
      beginStream()
      switching = start({ gguf: '/m/b.gguf', mmproj: '/m/b.mmproj', ...SPAWN_PROFILE }, 'mac')
      const refused = expectRefusalBeforeSpawn(switching, /start cancelled/)
      // This is the actual post-authority drain branch while the old stream is still held.
      await waitUntil(() => vi.mocked(mainLog.info).mock.calls.some(([message]) => /switch deferred/.test(message)))
      expect(procA.kill).not.toHaveBeenCalled()
      expect(spawnState.calls).toHaveLength(1)
      stop()
      expect(procA.kill).toHaveBeenCalledTimes(1)
      endStream()
      await refused
      expect(spawnState.calls).toHaveLength(1)
      expect(getState()).toBe('stopped')
      expect(isRunning()).toBe(false)
    } finally {
      stop()
      endStream()
      await Promise.allSettled([first, ...(switching ? [switching] : [])])
    }
  })

  it('does NOT kill the running sidecar while a stream is active — defers until the stream ends, then switches', async () => {
    const pathsA = { gguf: '/m/a.gguf', mmproj: '/m/a.mmproj', ...SPAWN_PROFILE }
    const pathsB = { gguf: '/m/b.gguf', mmproj: '/m/b.mmproj', ...SPAWN_PROFILE }

    const p1 = start(pathsA, 'mac')
    await emitListening(0, 55601)
    await p1
    const procA = spawnState.procs[0]

    beginStream() // simulates an in-flight suggest/summary/vision request actively streaming from A

    const p2 = start(pathsB, 'mac') // Settings 'Use this model' -> next local request requests a switch to B

    // Observe the real deferred branch while the stream is still held open.
    await waitUntil(() => vi.mocked(mainLog.info).mock.calls.some(([message]) => /switch deferred/.test(message)))
    expect(procA.kill).not.toHaveBeenCalled()
    expect(spawnState.calls.length).toBe(1) // B has not spawned — the switch is deferred, not abandoned
    expect(isRunning()).toBe(true)
    expect(baseURL()).toBe('http://127.0.0.1:55601/v1') // still A — the in-flight response can keep streaming

    endStream() // the in-flight request finishes (onDone/onError/abort)

    await waitUntil(() => spawnState.calls.length === 2) // NOW the deferred switch proceeds
    await emitListening(1, 55602)
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
    await emitListening(0, 55701)
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
    await emitListening(0, 55801)
    await p1
    const procA = spawnState.procs[0]

    const p2 = start(pathsB, 'mac')
    await waitUntil(() => spawnState.calls.length === 2)
    await emitListening(1, 55802)
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
    await emitListening(0, 55501)
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
    await emitListening(1, 55502)
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

describe('automatic restart failure ownership', () => {
  async function freshRuntime() {
    // stop() intentionally retains the restart budget. Each crash scenario gets a fresh real module,
    // and its provider must be configured on that same module graph, never on the static graph above.
    vi.resetModules()
    const runtime = await import('./local-runtime')
    const authority = await import('../features/components/speech-pack/package-runtime-state')
    authority.configurePackageRuntimeContractProvider(runtimeContractProvider)
    runtimeContract = Promise.resolve(fullRuntime)
    electron.app.isPackaged = true
    return runtime
  }

  async function observeRejectedAuthorityTurn(): Promise<void> {
    // After an invalid provider result, the real guard/start/catch path has only promise jobs and
    // synchronous work left. A real immediate observes that job queue drained; no elapsed-time slack.
    await yieldImmediate()
  }

  it.each([
    'stop',
    'stop-then-fresh',
    'fresh-without-stop',
    'current'
  ] as const)('handles a late real automatic-restart guard failure with current ownership: %s', async (scenario) => {
    const runtime = await freshRuntime()
    let authority: ReturnType<typeof heldRuntimeAuthority> | undefined
    try {
      const first = runtime.start({ gguf: '/m/a.gguf', mmproj: '/m/a.mmproj', ...SPAWN_PROFILE }, 'mac')
      await emitListening(0, 55931)
      await first
      authority = heldRuntimeAuthority()
      spawnState.procs[0].emit('exit', 1, null)
      expect(auditLog).toHaveBeenCalledWith('local.runtime.restart', { platform: 'mac' })
      expect(runtimeContractProvider).toHaveBeenCalledTimes(2)
      expect(spawnState.calls).toHaveLength(1)
      if (scenario === 'stop' || scenario === 'stop-then-fresh') expect(runtime.stop()).toBeUndefined()
      if (scenario === 'stop-then-fresh' || scenario === 'fresh-without-stop') {
        runtimeContract = Promise.resolve(fullRuntime)
        const fresh = runtime.start({ gguf: '/m/fresh.gguf', mmproj: '/m/fresh.mmproj', ...SPAWN_PROFILE }, 'mac')
        await emitListening(1, 55932)
        await fresh
        expect(runtime.isRunning()).toBe(true)
      }
      authority.resolve(invalidRuntime)
      await observeRejectedAuthorityTurn()
      expect(vi.mocked(auditLog).mock.calls.filter(([event]) => event === 'local.runtime.restart')).toHaveLength(1)
      if (scenario === 'stop-then-fresh' || scenario === 'fresh-without-stop') {
        expect(runtime.getState()).toBe('running')
        expect(runtime.baseURL()).toBe('http://127.0.0.1:55932/v1')
        expect(spawnState.procs[1].kill).not.toHaveBeenCalled()
        expect(spawnState.calls).toHaveLength(2)
      } else {
        expect(runtime.getState()).toBe(scenario === 'current' ? 'unavailable' : 'stopped')
        expect(runtime.isRunning()).toBe(false)
        expect(spawnState.calls).toHaveLength(1)
        expect(() => runtime.baseURL()).toThrow(/not running/)
        if (scenario === 'current') {
          runtimeContract = Promise.resolve(fullRuntime)
          await expect(
            runtime.start({ gguf: '/m/a.gguf', mmproj: '/m/a.mmproj', ...SPAWN_PROFILE }, 'mac')
          ).rejects.toThrow(/unavailable for this session/)
          expect(spawnState.calls).toHaveLength(1)
        }
      }
    } finally {
      runtime.stop()
      authority?.resolve(invalidRuntime)
    }
  })

  it('retains the one automatic restart per window limit after a successful restart', async () => {
    const runtime = await freshRuntime()
    try {
      const first = runtime.start({ gguf: '/m/a.gguf', mmproj: '/m/a.mmproj', ...SPAWN_PROFILE }, 'mac')
      await emitListening(0, 55941)
      await first
      spawnState.procs[0].emit('exit', 1, null)
      await emitListening(1, 55942)
      await waitUntil(() => runtime.isRunning())
      spawnState.procs[1].emit('exit', 1, null)
      expect(runtime.getState()).toBe('unavailable')
      expect(spawnState.calls).toHaveLength(2)
      expect(auditLog).toHaveBeenCalledWith('local.runtime.missing', {
        platform: 'mac',
        reason: 'restart_budget_exhausted'
      })
      expect(vi.mocked(auditLog).mock.calls.filter(([event]) => event === 'local.runtime.restart')).toHaveLength(1)
    } finally {
      runtime.stop()
    }
  })
})
