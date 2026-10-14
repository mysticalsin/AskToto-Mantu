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
vi.mock('../features/components/speech-pack/runtime-lease', async (importOriginal) => {
  const original = await importOriginal<typeof import('../features/components/speech-pack/runtime-lease')>()
  return { ...original, runtimeHostEnvironment: vi.fn(() => ({})) }
})

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
import type {
  RuntimeEntryRole,
  RuntimeFeatureLease,
  RuntimeModelId,
  VerifiedRuntimeResourcePin
} from '../features/components/speech-pack/runtime-lease'
import type { OptionalRuntimeTarget } from '../features/components/speech-pack/runtime-components'
import type { RuntimePhysicalAdmission } from '../infra/storage/runtime-owned-files'

type FetchImpl = (...args: unknown[]) => Promise<{ status: number }>
let fetchImpl: FetchImpl = async () => ({ status: 200 })

beforeEach(() => {
  vi.clearAllMocks()
  spawnState.procs = []
  spawnState.calls = []
  fetchImpl = async () => ({ status: 200 })
  vi.stubGlobal('fetch', (...args: unknown[]) => fetchImpl(...args))
})

afterEach(async () => {
  const stopping = stop()
  for (const proc of spawnState.procs) if (proc.killed) proc.emit('exit', null, 'SIGKILL')
  await stopping
  vi.unstubAllGlobals()
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

function testLease(
  generationIdentity: string,
  releaseLease: () => Promise<void> = async () => undefined,
  prepareAdmission: () => Promise<RuntimePhysicalAdmission> = async () => ({
    assertCurrentSync: vi.fn(),
    dispose: vi.fn(async () => undefined)
  })
): {
  lease: RuntimeFeatureLease
  release: ReturnType<typeof vi.fn>
  preparePhysicalAdmission: ReturnType<typeof vi.fn>
} {
  const release = vi.fn(releaseLease)
  const preparePhysicalAdmission = vi.fn(prepareAdmission)
  const target: OptionalRuntimeTarget = {
    packageProfileIdentity: 'fixture-profile',
    packagePlatform: 'darwin',
    packageArch: 'arm64',
    runningPlatform: 'darwin',
    runningArch: 'arm64',
    appVersion: '1.0.0',
    electronVersion: '43.6.0',
    nodeAbi: '136',
    napiVersion: '10',
    chromiumVersion: '143.0.0.0'
  }
  const lease: RuntimeFeatureLease = {
    feature: 'local-llm',
    generationIdentity,
    catalogIdentity: 'c'.repeat(64),
    target,
    verifyCurrentBytes: vi.fn(async () => undefined),
    preparePhysicalAdmission,
    loaderDirectories: vi.fn(() => []),
    entry: vi.fn((role: RuntimeEntryRole) => `/managed/${role}`),
    model: vi.fn((id: RuntimeModelId) => `/managed/model/${id}`),
    modelFile: vi.fn((_id: RuntimeModelId, member: string) => `/managed/model/${member}`),
    rendererFile: vi.fn((relativePath: string) => `/managed/${relativePath}`),
    rendererRolePath: vi.fn((role: RuntimeEntryRole) => `/managed/${role}`),
    rendererModelRoot: vi.fn((id: RuntimeModelId) => `/managed/model/${id}`),
    rendererResource: vi.fn(
      (relativePath: string): VerifiedRuntimeResourcePin => ({
        path: relativePath,
        bytes: 1,
        sha256: 'a'.repeat(64)
      })
    ),
    rendererResources: vi.fn(() => new Map<string, string>()),
    release
  }
  return { lease, release, preparePhysicalAdmission }
}

describe('F1 — concurrent start() calls share one in-flight start', () => {
  it('holds native launch until the leased physical closure has been reverified', async () => {
    let finishAdmission!: (admission: RuntimePhysicalAdmission) => void
    const lease = testLease(
      'managed-physical-gate',
      async () => undefined,
      () => new Promise<RuntimePhysicalAdmission>((resolve) => (finishAdmission = resolve))
    )
    const started = start(
      {
        gguf: '/managed/model/model.gguf',
        mmproj: '/managed/model/mmproj.gguf',
        ...SPAWN_PROFILE,
        runtimeLease: lease.lease,
        runtimeBinary: '/managed/llama-server'
      },
      'mac'
    )
    await waitUntil(() => lease.preparePhysicalAdmission.mock.calls.length === 1)
    expect(spawnState.calls).toHaveLength(0)
    const admission: RuntimePhysicalAdmission = {
      assertCurrentSync: vi.fn(),
      dispose: vi.fn(async () => undefined)
    }
    finishAdmission(admission)
    await waitUntil(() => spawnState.calls.length === 1)
    await emitListening(0, 55129)
    await started
    expect(spawnState.calls).toHaveLength(1)
    expect(admission.assertCurrentSync).toHaveBeenCalledOnce()
    expect(admission.dispose).toHaveBeenCalledOnce()
    await stop()
  })

  it('does not spawn when the held physical admission is no longer current at the synchronous launch guard', async () => {
    let finishAdmission!: (admission: RuntimePhysicalAdmission) => void
    const lease = testLease(
      'managed-stale-physical-gate',
      async () => undefined,
      () => new Promise<RuntimePhysicalAdmission>((resolve) => (finishAdmission = resolve))
    )
    const started = start(
      {
        gguf: '/managed/model/model.gguf',
        mmproj: '/managed/model/mmproj.gguf',
        ...SPAWN_PROFILE,
        runtimeLease: lease.lease,
        runtimeBinary: '/managed/llama-server'
      },
      'mac'
    )
    await waitUntil(() => lease.preparePhysicalAdmission.mock.calls.length === 1)
    expect(spawnState.calls).toHaveLength(0)
    let authorityCurrent = true
    const admission: RuntimePhysicalAdmission = {
      assertCurrentSync: vi.fn(() => {
        if (!authorityCurrent) throw new Error('physical admission became stale')
      }),
      dispose: vi.fn(async () => undefined)
    }
    authorityCurrent = false
    finishAdmission(admission)
    await expect(started).rejects.toThrow('physical admission became stale')
    expect(admission.assertCurrentSync).toHaveBeenCalledOnce()
    expect(admission.dispose).toHaveBeenCalledOnce()
    expect(spawnState.calls).toHaveLength(0)
  })

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

    // Reproduce app will-quit while Vulkan is still loading; start() must settle only after the child exits.
    const stopping = stop()
    await waitUntil(() => outcome !== undefined || spawnState.calls.length > 1)
    await stopping

    expect(outcome).toBe('rejected')
    expect(spawnState.calls).toHaveLength(1)
    expect(spawnState.procs[0].killed).toBe(true)
    expect(getState()).toBe('stopped')
    expect(isRunning()).toBe(false)
  })

  it('does not release a startup lease until the cancelled child has actually exited', async () => {
    const { lease, release } = testLease('managed-start')
    const paths = {
      gguf: '/managed/model.gguf',
      mmproj: '/managed/mmproj.gguf',
      ...SPAWN_PROFILE,
      runtimeLease: lease,
      runtimeBinary: '/managed/llama-server'
    }
    let settled = false
    const caller = (async () => {
      try {
        await start(paths, 'mac')
      } finally {
        await lease.release()
      }
    })().finally(() => {
      settled = true
    })
    await waitUntil(() => spawnState.procs[0] !== undefined)
    const proc = spawnState.procs[0]!
    proc.kill = vi.fn(() => {
      proc.killed = true
    })

    const stopping = stop()
    await Promise.resolve()
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL')
    expect(settled).toBe(false)
    expect(release).not.toHaveBeenCalled()

    proc.emit('exit', null, 'SIGKILL')
    await stopping
    await expect(caller).rejects.toThrow(/cancelled/i)
    expect(release).toHaveBeenCalledOnce()
    expect(spawnState.calls).toHaveLength(1)
  })

  it('transfers a successful child lease once and holds it through stop plus replacement startup', async () => {
    const oldLease = testLease('managed-old')
    const oldPaths = {
      gguf: '/managed/old.gguf',
      mmproj: '/managed/mmproj.gguf',
      ...SPAWN_PROFILE,
      runtimeLease: oldLease.lease,
      runtimeBinary: '/managed/llama-server'
    }
    const startedOld = start(oldPaths, 'mac')
    await emitListening(0, 55920)
    await startedOld
    const oldProc = spawnState.procs[0]!
    oldProc.kill = vi.fn(() => {
      oldProc.killed = true
    })

    const stopping = stop()
    const nextStart = start({ gguf: '/m/new.gguf', mmproj: '/m/new.mmproj', ...SPAWN_PROFILE }, 'mac')
    await Promise.resolve()
    expect(spawnState.calls).toHaveLength(1)
    expect(oldLease.release).not.toHaveBeenCalled()

    oldProc.emit('exit', null, 'SIGKILL')
    await stopping
    await waitUntil(() => spawnState.calls.length === 2)
    await emitListening(1, 55921)
    await nextStart
    expect(oldLease.release).toHaveBeenCalledOnce()
    expect(isRunning()).toBe(true)
    expect(baseURL()).toBe('http://127.0.0.1:55921/v1')

    await stop()
  })

  it('keeps a replacement behind the emitted exit and completion of the owned lease release', async () => {
    let finishRelease: () => void = () => {}
    const oldLease = testLease(
      'managed-held-exit',
      () =>
        new Promise<void>((resolve) => {
          finishRelease = resolve
        })
    )
    const oldPaths = {
      gguf: '/managed/old.gguf',
      mmproj: '/managed/mmproj.gguf',
      ...SPAWN_PROFILE,
      runtimeLease: oldLease.lease,
      runtimeBinary: '/managed/llama-server'
    }
    const startedOld = start(oldPaths, 'mac')
    await emitListening(0, 55930)
    await startedOld
    const oldProc = spawnState.procs[0]!
    oldProc.kill = vi.fn(() => {
      oldProc.killed = true
    })

    let stopSettled = false
    const stopping = stop().finally(() => {
      stopSettled = true
    })
    const nextStart = start({ gguf: '/m/new.gguf', mmproj: '/m/new.mmproj', ...SPAWN_PROFILE }, 'mac')
    oldProc.emit('exit', null, 'SIGKILL')
    await waitUntil(() => oldLease.release.mock.calls.length === 1)

    expect(stopSettled).toBe(false)
    expect(spawnState.calls).toHaveLength(1)
    expect(oldLease.release).toHaveBeenCalledOnce()

    finishRelease()
    await stopping
    await waitUntil(() => spawnState.calls.length === 2)
    await emitListening(1, 55931)
    await nextStart
    expect(spawnState.calls).toHaveLength(2)
    expect(isRunning()).toBe(true)
    await stop()
  })

  it('a new start waits for the cancelled child exit and stale output cannot replace its port', async () => {
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
    // Hold A's OS exit notification so B proves it cannot launch while A still owns the model/process.
    procA.kill = vi.fn(() => {
      procA.killed = true
    })
    const stopping = stop()

    const startB = start(pathsB, 'mac')
    await Promise.resolve()
    expect(spawnState.calls).toHaveLength(1)
    procA.emit('exit', null, 'SIGKILL')
    await stopping
    await waitUntil(() => spawnState.calls.length === 2)
    await emitListening(1, 55902)
    await startB
    expect(baseURL()).toBe('http://127.0.0.1:55902/v1')

    await emitListening(0, 55901)
    await waitUntil(() => outcomeA !== undefined)

    expect(outcomeA).toBe('rejected')
    expect(isRunning()).toBe(true)
    expect(baseURL()).toBe('http://127.0.0.1:55902/v1')
    await stop()
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
    let releaseHealthA: () => void = () => {}
    fetchImpl = () =>
      new Promise((resolve) => {
        releaseHealthA = () => resolve({ status: 200 })
      })

    const pathsA = { gguf: '/m/a.gguf', mmproj: '/m/a.mmproj', ...SPAWN_PROFILE }
    const pathsB = { gguf: '/m/b.gguf', mmproj: '/m/b.mmproj', ...SPAWN_PROFILE }

    const p1 = start(pathsA, 'mac') // still "starting" — health never resolves until released below
    await emitListening(0, 55401)

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

  it('does NOT kill the running sidecar while a stream is active — defers until the stream ends, then switches', async () => {
    const pathsA = { gguf: '/m/a.gguf', mmproj: '/m/a.mmproj', ...SPAWN_PROFILE }
    const pathsB = { gguf: '/m/b.gguf', mmproj: '/m/b.mmproj', ...SPAWN_PROFILE }

    const p1 = start(pathsA, 'mac')
    await emitListening(0, 55601)
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

  it('does not resolve a same-generation start if Stop wins while an unused incoming lease is releasing', async () => {
    const pathsA = { gguf: '/m/a.gguf', mmproj: '/m/a.mmproj', ...SPAWN_PROFILE }
    const activeLease = testLease('a'.repeat(64))
    const running = start({ ...pathsA, runtimeLease: activeLease.lease, runtimeBinary: '/managed/llama-server' }, 'mac')
    await emitListening(0, 55702)
    await running

    let finishRelease!: () => void
    const releaseHeld = new Promise<void>((resolve) => {
      finishRelease = resolve
    })
    const incomingLease = testLease('a'.repeat(64), () => releaseHeld)
    const redundantStart = start(
      { ...pathsA, runtimeLease: incomingLease.lease, runtimeBinary: '/managed/llama-server' },
      'mac'
    )
    await waitUntil(() => incomingLease.release.mock.calls.length === 1)

    await stop()
    finishRelease()
    await expect(redundantStart).rejects.toThrow('local runtime start cancelled')
    expect(isRunning()).toBe(false)
    expect(activeLease.release).toHaveBeenCalledTimes(1)
    expect(incomingLease.release).toHaveBeenCalledTimes(1)
    expect(spawnState.calls).toHaveLength(1)
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
  it('old stop completion and duplicate stale exit cannot clear a newer child', async () => {
    const pathsA = { gguf: '/m/a.gguf', mmproj: '/m/a.mmproj', ...SPAWN_PROFILE }
    const pathsB = { gguf: '/m/b.gguf', mmproj: '/m/b.mmproj', ...SPAWN_PROFILE }

    const p1 = start(pathsA, 'mac')
    await emitListening(0, 55501)
    await p1
    const procA = spawnState.procs[0]

    // Hold the exit so stop() and a replacement start share A's exact barrier.
    procA.kill = vi.fn(() => {
      procA.killed = true
    })

    const stopping = stop()
    const p2 = start(pathsB, 'mac')
    await Promise.resolve()
    expect(spawnState.calls).toHaveLength(1)
    procA.emit('exit', null, 'SIGKILL')
    await stopping
    await waitUntil(() => spawnState.calls.length === 2)
    await emitListening(1, 55502)
    await p2
    expect(isRunning()).toBe(true)
    expect(baseURL()).toBe('http://127.0.0.1:55502/v1')

    // A duplicate late exit must not clear B's state or port.
    procA.emit('exit', null, 'SIGKILL')
    await Promise.resolve()
    await Promise.resolve()

    expect(isRunning()).toBe(true)
    expect(baseURL()).toBe('http://127.0.0.1:55502/v1') // still B's port — untouched by A's stale exit
    expect(auditLog).not.toHaveBeenCalledWith('local.runtime.crash', expect.anything())
    expect(spawnState.calls.length).toBe(2) // no auto-restart spawn triggered by the stale exit

    const finalStop = stop()
    await finalStop
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
