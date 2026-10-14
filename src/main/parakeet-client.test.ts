import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeFeatureLease } from './features/components/speech-pack/runtime-lease'

class FakeChild extends EventEmitter {
  readonly postMessage = vi.fn()
  readonly kill = vi.fn(() => true)
  readonly stderr = new EventEmitter()
  readonly stdout = new EventEmitter()
}

const electron = vi.hoisted(() => ({ utilityProcess: { fork: vi.fn() } }))
const paths = vi.hoisted(() => ({ model: '' }))
const runtime = vi.hoisted(() => ({
  acquire: vi.fn(
    async (_feature: 'offline-asr' | 'speaker-embedding' | 'local-llm'): Promise<RuntimeFeatureLease | null> => null
  )
}))

vi.mock('electron', () => electron)
vi.mock('./features/components/speech-pack/runtime-admission', () => ({
  acquirePackageRuntimeLease: runtime.acquire
}))
vi.mock('./features/components/speech-pack/runtime-lease', async (importOriginal) => {
  const original = await importOriginal<typeof import('./features/components/speech-pack/runtime-lease')>()
  return { ...original, runtimeHostEnvironment: vi.fn(() => ({})) }
})
vi.mock('./logger', () => ({ mainLog: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))
vi.mock('./asr-bundled-ensure', () => ({
  ASR_ASSETS_MISSING: 'assets missing',
  PARAKEET_MODEL_NAME: 'parakeet-test',
  ensureParakeetAssets: vi.fn(async () => undefined),
  parakeetFilesReady: vi.fn(() => true),
  resolveParakeetDir: () => paths.model
}))

type Api = typeof import('./parakeet')
type ResizableArrayBuffer = ArrayBuffer & { resize(byteLength: number): void }
const ResizableBuffer = ArrayBuffer as unknown as {
  new (byteLength: number, options: { maxByteLength: number }): ResizableArrayBuffer
  prototype: ResizableArrayBuffer
}
let api: Api
let child: FakeChild

type ReleaseMock = ReturnType<typeof vi.fn<() => Promise<void>>>
type RuntimeLeaseOverrides = Omit<Partial<RuntimeFeatureLease>, 'release'> & {
  release?: ReleaseMock
}

function runtimeLease(overrides: RuntimeLeaseOverrides = {}): RuntimeFeatureLease & {
  release: ReleaseMock
} {
  const lease: RuntimeFeatureLease & { release: ReleaseMock } = {
    feature: 'offline-asr',
    generationIdentity: 'fixture-generation',
    catalogIdentity: 'fixture-catalog',
    target: {
      packageProfileIdentity: null,
      packagePlatform: null,
      packageArch: null,
      runningPlatform: process.platform,
      runningArch: process.arch,
      appVersion: 'test',
      electronVersion: undefined,
      nodeAbi: undefined,
      napiVersion: undefined,
      chromiumVersion: undefined
    },
    verifyCurrentBytes: async () => undefined,
    preparePhysicalAdmission: async () => ({ assertCurrentSync: () => undefined, dispose: async () => undefined }),
    loaderDirectories: () => [],
    entry: vi.fn(() => '/runtime/parakeet-asr-host.js'),
    model: vi.fn(() => paths.model),
    modelFile: vi.fn(() => join(paths.model, 'model.bin')),
    rendererFile: vi.fn(() => join(paths.model, 'worker.js')),
    rendererRolePath: vi.fn(() => join(paths.model, 'worker.js')),
    rendererModelRoot: vi.fn(() => paths.model),
    rendererResource: vi.fn(() => ({ path: join(paths.model, 'worker.js'), bytes: 1, sha256: 'a'.repeat(64) })),
    rendererResources: () => new Map([['runtime/worker.js', join(paths.model, 'worker.js')]]),
    release: vi.fn(async () => undefined),
    ...overrides
  }
  return lease
}

function runtimeLeases(): Array<RuntimeFeatureLease & { release: ReleaseMock }> {
  const leases: Array<RuntimeFeatureLease & { release: ReleaseMock }> = []
  runtime.acquire.mockImplementation(async () => {
    const lease = runtimeLease()
    leases.push(lease)
    return lease
  })
  return leases
}

async function waitForRequest(target: FakeChild, type: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 50; i++) {
    const found = target.postMessage.mock.calls.map(([m]) => m as Record<string, unknown>).find((m) => m.type === type)
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`fake Parakeet child never received ${type}`)
}

function transcribeRequests(target: FakeChild): Array<{ type: string; id: string; pcm: ArrayBuffer }> {
  return target.postMessage.mock.calls
    .map(([message]) => message as { type: string; id: string; pcm: ArrayBuffer })
    .filter((message) => message.type === 'transcribe')
}

async function waitForTranscribeRequests(target: FakeChild, count: number): Promise<void> {
  await vi.waitFor(() => expect(transcribeRequests(target)).toHaveLength(count))
}

beforeEach(async () => {
  paths.model = mkdtempSync(join(tmpdir(), 'metis-parakeet-client-'))
  mkdirSync(paths.model, { recursive: true })
  for (const name of ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']) {
    writeFileSync(join(paths.model, name), Buffer.alloc(2_048, 1))
  }
  child = new FakeChild()
  electron.utilityProcess.fork.mockReset().mockReturnValue(child)
  runtime.acquire.mockReset().mockResolvedValue(null)
  vi.resetModules()
  api = await import('./parakeet')
})

afterEach(async () => {
  const lastFork = electron.utilityProcess.fork.mock.results.slice(-1)[0]?.value as FakeChild | undefined
  const activeChild = lastFork ?? child
  const releasing = api?.parakeetRelease().catch(() => undefined)
  activeChild?.emit('exit', 0)
  await releasing
  vi.useRealTimers()
  rmSync(paths.model, { recursive: true, force: true })
})

describe('Parakeet utilityProcess client', () => {
  it('probes native availability in one child without constructing weights in the parent', async () => {
    const status = api.parakeetAddonError()
    const request = await waitForRequest(child, 'probe')

    expect(electron.utilityProcess.fork).toHaveBeenCalledTimes(1)
    expect(electron.utilityProcess.fork.mock.calls[0][0]).toMatch(/parakeet-asr-host\.js$/)
    child.emit('message', { type: 'result', id: request.id })

    await expect(status).resolves.toBeNull()
  })

  it('shares one generation across concurrent startup and preserves caller samples', async () => {
    const samples = Float32Array.from([0.25, -0.5, 0.75])
    const original = [...samples]
    const first = api.parakeetTranscribe(samples)
    const second = api.parakeetTranscribe(Float32Array.from([0.1]))
    void first.catch(() => undefined)
    void second.catch(() => undefined)
    const firstRequest = await waitForRequest(child, 'transcribe')
    await waitForTranscribeRequests(child, 2)
    const requests = transcribeRequests(child)

    expect(electron.utilityProcess.fork).toHaveBeenCalledTimes(1)
    expect(requests).toHaveLength(2)
    expect(requests[0].id).not.toBe(requests[1].id)
    expect([...samples]).toEqual(original)
    expect(samples.byteLength).toBe(12)

    child.emit('message', { type: 'result', id: firstRequest.id, text: '  first  ' })
    child.emit('message', { type: 'result', id: requests[1].id, text: '' })
    await expect(first).resolves.toBe('first')
    await expect(second).resolves.toBe('')
  })

  it('rechecks the shared generation after a held lease verification', async () => {
    let releaseFirstVerification!: () => void
    const firstVerification = new Promise<void>((resolve) => {
      releaseFirstVerification = resolve
    })
    let verifications = 0
    const releases: Array<ReturnType<typeof vi.fn>> = []
    runtime.acquire.mockImplementation(async () => {
      const release = vi.fn(async () => undefined)
      releases.push(release)
      return runtimeLease({
        verifyCurrentBytes: vi.fn(async () => {
          verifications += 1
          if (verifications === 1) await firstVerification
        }),
        release
      })
    })

    const first = api.parakeetTranscribe(Float32Array.from([0.25]))
    const second = api.parakeetTranscribe(Float32Array.from([0.5]))
    void first.catch(() => undefined)
    void second.catch(() => undefined)
    for (let i = 0; i < 50 && verifications < 2; i++) await new Promise((resolve) => setTimeout(resolve, 0))
    expect(verifications).toBe(2)
    releaseFirstVerification()

    await waitForTranscribeRequests(child, 2)
    const requests = child.postMessage.mock.calls
      .map(([message]) => message as { type?: string; id?: string })
      .filter((message): message is { type: string; id: string } => message.type === 'transcribe' && !!message.id)
    expect(electron.utilityProcess.fork).toHaveBeenCalledTimes(1)
    expect(releases.filter((release) => release.mock.calls.length > 0)).toHaveLength(1)
    for (const request of requests) child.emit('message', { type: 'result', id: request.id, text: 'ok' })
    await expect(Promise.all([first, second])).resolves.toEqual(['ok', 'ok'])
  })

  it('reselects the shared generation after held physical admission and releases only the unused lease', async () => {
    const admissions: Array<{ entered: Promise<void>; release: () => void }> = []
    const leases: Array<RuntimeFeatureLease & { release: ReleaseMock }> = []
    runtime.acquire.mockImplementation(async () => {
      let enter!: () => void
      const entered = new Promise<void>((resolve) => {
        enter = resolve
      })
      let releaseAdmission!: () => void
      const held = new Promise<void>((resolve) => {
        releaseAdmission = resolve
      })
      admissions.push({ entered, release: releaseAdmission })
      const lease = runtimeLease({
        preparePhysicalAdmission: async () => {
          enter()
          await held
          return { assertCurrentSync: () => undefined, dispose: async () => undefined }
        }
      })
      leases.push(lease)
      return lease
    })

    const first = api.parakeetTranscribe(Float32Array.from([0.25]))
    const second = api.parakeetTranscribe(Float32Array.from([0.5]))
    void first.catch(() => undefined)
    void second.catch(() => undefined)
    await vi.waitFor(() => expect(admissions).toHaveLength(2))
    await Promise.all(admissions.map((admission) => admission.entered))

    admissions[0]!.release()
    await waitForRequest(child, 'transcribe')
    expect(electron.utilityProcess.fork).toHaveBeenCalledOnce()

    admissions[1]!.release()
    await vi.waitFor(() => {
      expect(
        child.postMessage.mock.calls.filter(([message]) => (message as { type?: string }).type === 'transcribe')
      ).toHaveLength(2)
    })
    const requests = child.postMessage.mock.calls
      .map(([message]) => message as { type?: string; id?: string })
      .filter((message): message is { type: string; id: string } => message.type === 'transcribe' && !!message.id)
    expect(requests).toHaveLength(2)
    expect(requests[0]?.id).not.toBe(requests[1]?.id)
    expect(electron.utilityProcess.fork).toHaveBeenCalledOnce()
    expect(leases.filter((lease) => lease.release.mock.calls.length > 0)).toHaveLength(1)

    for (const request of requests) child.emit('message', { type: 'result', id: request.id, text: 'ok' })
    await expect(Promise.all([first, second])).resolves.toEqual(['ok', 'ok'])

    const releasing = api.parakeetRelease()
    child.emit('exit', 0)
    await releasing
    expect(leases.every((lease) => lease.release.mock.calls.length === 1)).toBe(true)
  })

  it('retains a spawned child lease when physical-admission disposal fails', async () => {
    let disposalRejected = false
    const release = vi.fn(async () => undefined)
    runtime.acquire.mockImplementationOnce(async () =>
      runtimeLease({
        preparePhysicalAdmission: async () => ({
          assertCurrentSync: () => undefined,
          dispose: async () => {
            await Promise.resolve()
            try {
              throw new Error('physical admission disposal failed')
            } catch (error) {
              disposalRejected = true
              throw error
            }
          }
        }),
        release
      })
    )

    const request = api.parakeetTranscribe(Float32Array.from([0.25]))
    const rejected = expect(request).rejects.toThrow('physical admission disposal failed')
    let exited = false
    try {
      await vi.waitFor(() => expect(disposalRejected).toBe(true))
      await vi.waitFor(() => expect(child.kill).toHaveBeenCalledOnce())
      expect(electron.utilityProcess.fork).toHaveBeenCalledOnce()
      expect(release).not.toHaveBeenCalled()
      child.emit('exit', 0)
      exited = true
      await rejected
      expect(release).toHaveBeenCalledOnce()
    } finally {
      if (!exited) child.emit('exit', 0)
      await rejected.catch(() => undefined)
    }
  })

  it('rejects a stale physical admission before creating a child', async () => {
    const release = vi.fn(async () => undefined)
    const dispose = vi.fn(async () => undefined)
    runtime.acquire.mockImplementationOnce(async () =>
      runtimeLease({
        preparePhysicalAdmission: async () => ({
          assertCurrentSync: () => {
            throw new Error('physical admission is stale')
          },
          dispose
        }),
        release
      })
    )

    await expect(api.parakeetTranscribe(Float32Array.from([0.25]))).rejects.toThrow('physical admission is stale')
    expect(electron.utilityProcess.fork).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
  })

  it('releases a prepared lease without forking when cancellation wins during physical admission', async () => {
    let admissionEntered!: () => void
    const entered = new Promise<void>((resolve) => {
      admissionEntered = resolve
    })
    let resolveAdmission!: () => void
    const held = new Promise<void>((resolve) => {
      resolveAdmission = resolve
    })
    const release = vi.fn(async () => undefined)
    const dispose = vi.fn(async () => undefined)
    runtime.acquire.mockImplementationOnce(async () =>
      runtimeLease({
        preparePhysicalAdmission: async () => {
          admissionEntered()
          await held
          return { assertCurrentSync: () => undefined, dispose }
        },
        release
      })
    )

    const request = api.parakeetTranscribe(Float32Array.from([0.25]))
    const rejected = expect(request).rejects.toThrow(/cancelled/i)
    await entered
    await api.parakeetRelease()
    resolveAdmission()
    await rejected
    expect(dispose).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
    expect(electron.utilityProcess.fork).not.toHaveBeenCalled()
  })

  it('does not return a shared child after cancellation while unused lease release is held', async () => {
    const admissions: Array<{ entered: Promise<void>; release: () => void }> = []
    let enterUnusedLeaseRelease!: () => void
    const unusedLeaseReleaseEntered = new Promise<void>((resolve) => {
      enterUnusedLeaseRelease = resolve
    })
    let finishUnusedLeaseRelease!: () => void
    const unusedLeaseRelease = new Promise<void>((resolve) => {
      finishUnusedLeaseRelease = resolve
    })
    const leases: Array<RuntimeFeatureLease & { release: ReleaseMock }> = []
    runtime.acquire.mockImplementation(async () => {
      let enterAdmission!: () => void
      const entered = new Promise<void>((resolve) => {
        enterAdmission = resolve
      })
      let finishAdmission!: () => void
      const heldAdmission = new Promise<void>((resolve) => {
        finishAdmission = resolve
      })
      admissions.push({ entered, release: finishAdmission })
      const index = admissions.length - 1
      const lease = runtimeLease({
        preparePhysicalAdmission: async () => {
          enterAdmission()
          await heldAdmission
          return { assertCurrentSync: () => undefined, dispose: async () => undefined }
        },
        release:
          index === 1
            ? vi.fn(async () => {
                enterUnusedLeaseRelease()
                await unusedLeaseRelease
              })
            : vi.fn(async () => undefined)
      })
      leases.push(lease)
      return lease
    })

    const first = api.parakeetTranscribe(Float32Array.from([0.25]))
    const firstFailure = expect(first).rejects.toThrow(/cancelled/i)
    const second = api.parakeetTranscribe(Float32Array.from([0.5]))
    const secondFailure = expect(second).rejects.toThrow(/cancelled/i)
    await vi.waitFor(() => expect(admissions).toHaveLength(2))
    await Promise.all(admissions.map((admission) => admission.entered))

    admissions[0]!.release()
    await waitForRequest(child, 'transcribe')
    admissions[1]!.release()
    await unusedLeaseReleaseEntered
    expect(
      child.postMessage.mock.calls.filter(([message]) => (message as { type?: string }).type === 'transcribe')
    ).toHaveLength(1)

    const releasing = api.parakeetRelease()
    expect(child.kill).toHaveBeenCalledOnce()
    child.emit('exit', 0)
    await releasing
    finishUnusedLeaseRelease()
    await Promise.all([firstFailure, secondFailure])
    expect(electron.utilityProcess.fork).toHaveBeenCalledOnce()
    expect(leases[1]?.release).toHaveBeenCalledOnce()
    expect(
      child.postMessage.mock.calls.filter(([message]) => (message as { type?: string }).type === 'transcribe')
    ).toHaveLength(1)
  })

  it('rejects non-finite and oversized PCM before forking a child', async () => {
    await expect(api.parakeetTranscribe(Float32Array.from([Number.NaN]))).rejects.toThrow(/finite/i)
    await expect(api.parakeetTranscribe(new Float32Array(16_000 * 30 + 1))).rejects.toThrow(/too large/i)
    expect(electron.utilityProcess.fork).not.toHaveBeenCalled()
  })

  it('bounds aggregate queued PCM and restores admission when one decode finishes', async () => {
    const maxWindow = new Float32Array(16_000 * 30)
    const first = api.parakeetTranscribe(maxWindow)
    const second = api.parakeetTranscribe(maxWindow)
    void first.catch(() => undefined)
    void second.catch(() => undefined)
    await waitForTranscribeRequests(child, 2)

    await expect(api.parakeetTranscribe(new Float32Array(1))).rejects.toMatchObject({
      name: 'ParakeetBusyError',
      code: 'PARAKEET_BUSY',
      message: expect.stringMatching(/busy.*retry/i)
    })
    const requests = child.postMessage.mock.calls
      .map(([message]) => message as { type: string; id: string })
      .filter((message) => message.type === 'transcribe')
    expect(requests).toHaveLength(2)

    child.emit('message', { type: 'result', id: requests[0].id, text: 'first' })
    await expect(first).resolves.toBe('first')
    const third = api.parakeetTranscribe(new Float32Array(1))
    void third.catch(() => undefined)
    await waitForTranscribeRequests(child, 3)
    const allRequests = child.postMessage.mock.calls
      .map(([message]) => message as { type: string; id: string })
      .filter((message) => message.type === 'transcribe')
    expect(allRequests).toHaveLength(3)
    const newest = allRequests[2]
    child.emit('message', { type: 'result', id: requests[1].id, text: 'second' })
    child.emit('message', { type: 'result', id: newest!.id, text: 'third' })
    await expect(second).resolves.toBe('second')
    await expect(third).resolves.toBe('third')
  })

  it('releases the immutable admission amount after callers detach their original buffers', async () => {
    const windows = [new Float32Array(16_000 * 30), new Float32Array(16_000 * 30)]
    const pending = windows.map((window) => api.parakeetTranscribe(window))
    for (const window of windows) structuredClone(window.buffer, { transfer: [window.buffer] })
    expect(windows.map((window) => window.byteLength)).toEqual([0, 0])

    for (let i = 0; i < 50 && child.postMessage.mock.calls.length < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const requests = child.postMessage.mock.calls.map(([message]) => message as { id: string })
    child.emit('message', { type: 'result', id: requests[0].id, text: 'first' })
    child.emit('message', { type: 'result', id: requests[1].id, text: 'second' })
    await Promise.all(pending)

    const later = api.parakeetTranscribe(new Float32Array(1))
    for (let i = 0; i < 50 && child.postMessage.mock.calls.length < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const laterRequest = child.postMessage.mock.calls[2][0] as { id: string }
    child.emit('message', { type: 'result', id: laterRequest.id, text: 'capacity restored' })
    await expect(later).resolves.toBe('capacity restored')
  })

  it.runIf(typeof ResizableBuffer.prototype.resize === 'function')(
    'releases the immutable admission amount after callers resize their original buffers',
    async () => {
      const byteLength = 16_000 * 30 * Float32Array.BYTES_PER_ELEMENT
      const buffers = [
        new ResizableBuffer(byteLength, { maxByteLength: byteLength }),
        new ResizableBuffer(byteLength, { maxByteLength: byteLength })
      ]
      const pending = buffers.map((buffer) => api.parakeetTranscribe(new Float32Array(buffer)))
      for (const buffer of buffers) buffer.resize(0)

      for (let i = 0; i < 50 && child.postMessage.mock.calls.length < 2; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      const requests = child.postMessage.mock.calls.map(([message]) => message as { id: string })
      child.emit('message', { type: 'result', id: requests[0].id, text: 'first' })
      child.emit('message', { type: 'result', id: requests[1].id, text: 'second' })
      await Promise.all(pending)

      const later = api.parakeetTranscribe(new Float32Array(1))
      for (let i = 0; i < 50 && child.postMessage.mock.calls.length < 3; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      const laterRequest = child.postMessage.mock.calls[2][0] as { id: string }
      child.emit('message', { type: 'result', id: laterRequest.id, text: 'capacity restored' })
      await expect(later).resolves.toBe('capacity restored')
    }
  )

  it('bounds non-audio requests in the generation pending map', async () => {
    const warming = Array.from({ length: 16 }, () => api.ensureParakeetModel())
    for (let i = 0; i < 50 && child.postMessage.mock.calls.length < 16; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(child.postMessage).toHaveBeenCalledTimes(16)
    await expect(api.ensureParakeetModel()).rejects.toMatchObject({
      name: 'ParakeetBusyError',
      code: 'PARAKEET_BUSY'
    })

    for (const [request] of child.postMessage.mock.calls) {
      child.emit('message', { type: 'result', id: request.id })
    }
    await expect(Promise.all(warming)).resolves.toHaveLength(16)
  })

  it('surfaces a native request failure and ignores a late duplicate result', async () => {
    const pending = api.parakeetTranscribe(new Float32Array(16))
    const request = await waitForRequest(child, 'transcribe')
    child.emit('message', { type: 'error', id: request.id, message: 'native decode failed' })
    await expect(pending).rejects.toThrow('native decode failed')

    child.emit('message', { type: 'result', id: request.id, text: 'late success' })
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('does not hide a real native warmup failure', async () => {
    const warming = api.ensureParakeetModel()
    const request = await waitForRequest(child, 'warmup')
    child.emit('message', { type: 'error', id: request.id, message: 'model construction failed' })

    await expect(warming).rejects.toThrow('model construction failed')
  })

  it('pins exact model files in native requests and keeps the generation lease until child exit', async () => {
    const leases = runtimeLeases()
    const warming = api.ensureParakeetModel()
    const request = await waitForRequest(child, 'warmup')

    expect(request.files).toEqual({
      encoder: join(paths.model, 'encoder.int8.onnx'),
      decoder: join(paths.model, 'decoder.int8.onnx'),
      joiner: join(paths.model, 'joiner.int8.onnx'),
      tokens: join(paths.model, 'tokens.txt')
    })
    expect(leases).toHaveLength(2)
    child.emit('message', { type: 'result', id: request.id })
    await warming
    expect(leases[0].release).toHaveBeenCalledOnce()
    expect(leases[1].release).not.toHaveBeenCalled()

    let released = false
    const release = api.parakeetRelease().then(() => {
      released = true
    })
    await Promise.resolve()
    expect(child.kill).toHaveBeenCalledOnce()
    expect(leases[1].release).not.toHaveBeenCalled()
    expect(released).toBe(false)

    child.emit('exit', 0)
    await release
    expect(leases[1].release).toHaveBeenCalledOnce()
  })

  it('releases a lease acquired after cancellation without forking or posting native work', async () => {
    let resolveLease!: (lease: RuntimeFeatureLease | null) => void
    const leaseAcquiring = new Promise<RuntimeFeatureLease | null>((resolve) => {
      resolveLease = resolve
    })
    runtime.acquire.mockImplementationOnce(() => leaseAcquiring)
    const warming = api.ensureParakeetModel()
    await vi.waitFor(() => expect(runtime.acquire).toHaveBeenCalledOnce())

    await api.parakeetRelease()
    const lease = runtimeLease()
    resolveLease(lease)

    await expect(warming).rejects.toThrow(/cancelled/i)
    expect(lease.release).toHaveBeenCalledOnce()
    expect(electron.utilityProcess.fork).not.toHaveBeenCalled()
    expect(child.postMessage).not.toHaveBeenCalled()
  })

  it('rejects all generation work on crash and old-child events cannot poison the restarted generation', async () => {
    const first = api.parakeetTranscribe(new Float32Array(16))
    await waitForRequest(child, 'transcribe')
    child.emit('exit', 137)
    await expect(first).rejects.toThrow(/exited unexpectedly.*137/i)

    const secondChild = new FakeChild()
    electron.utilityProcess.fork.mockReturnValue(secondChild)
    const second = api.parakeetTranscribe(new Float32Array(16))
    const secondRequest = await waitForRequest(secondChild, 'transcribe')
    child.emit('exit', 0)
    child.emit('message', { type: 'result', id: secondRequest.id, text: 'stale' })
    secondChild.emit('message', { type: 'result', id: secondRequest.id, text: 'fresh' })

    await expect(second).resolves.toBe('fresh')
    expect(electron.utilityProcess.fork).toHaveBeenCalledTimes(2)
  })

  it('postMessage failure kills that generation and a request during release waits for its exit', async () => {
    child.postMessage.mockImplementationOnce(() => {
      throw new Error('channel closed')
    })
    const failed = api.parakeetTranscribe(new Float32Array(16))
    await expect(failed).rejects.toThrow('channel closed')
    expect(child.kill).toHaveBeenCalledTimes(1)

    const secondChild = new FakeChild()
    electron.utilityProcess.fork.mockReturnValue(secondChild)
    const waiting = api.parakeetTranscribe(new Float32Array(16))
    await Promise.resolve()
    expect(electron.utilityProcess.fork).toHaveBeenCalledTimes(1)

    child.emit('exit', 0)
    const request = await waitForRequest(secondChild, 'transcribe')
    secondChild.emit('message', { type: 'result', id: request.id, text: 'recovered' })
    await expect(waiting).resolves.toBe('recovered')
  })

  it('timeout rejects pending work, kills the hung helper, and delays restart until exit', async () => {
    vi.useFakeTimers()
    const timedOut = api.parakeetTranscribe(new Float32Array(16))
    const timeoutAssertion = expect(timedOut).rejects.toThrow(/timed out/i)
    await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalled())
    expect(child.postMessage).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(120_001)
    await timeoutAssertion
    expect(child.kill).toHaveBeenCalledTimes(1)

    const secondChild = new FakeChild()
    electron.utilityProcess.fork.mockReturnValue(secondChild)
    const waiting = api.parakeetTranscribe(new Float32Array(16))
    expect(electron.utilityProcess.fork).toHaveBeenCalledTimes(1)
    child.emit('exit', 0)
    await vi.waitFor(() => expect(electron.utilityProcess.fork).toHaveBeenCalledTimes(2))

    const request = secondChild.postMessage.mock.calls[0][0] as { id: string }
    secondChild.emit('message', { type: 'result', id: request.id, text: 'after timeout' })
    await expect(waiting).resolves.toBe('after timeout')
  })

  it('MQA-042 release resolves only after the exact child exits and blocks a second recognizer generation', async () => {
    const warm = api.ensureParakeetModel()
    const warmRequest = await waitForRequest(child, 'warmup')
    child.emit('message', { type: 'result', id: warmRequest.id })
    await warm

    let released = false
    const releasing = api.parakeetRelease().then(() => {
      released = true
    })
    await Promise.resolve()
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(released).toBe(false)

    const secondChild = new FakeChild()
    electron.utilityProcess.fork.mockReturnValue(secondChild)
    const waiting = api.parakeetTranscribe(new Float32Array(16))
    await Promise.resolve()
    expect(electron.utilityProcess.fork).toHaveBeenCalledTimes(1)

    child.emit('exit', 0)
    await releasing
    const request = await waitForRequest(secondChild, 'transcribe')
    secondChild.emit('message', { type: 'result', id: request.id, text: 'new generation' })
    await expect(waiting).resolves.toBe('new generation')
  })

  it('does not fork when release wins during async model-path resolution', async () => {
    const racing = api.parakeetTranscribe(new Float32Array(16))
    const releasing = api.parakeetRelease()
    await expect(racing).rejects.toThrow(/cancelled/i)
    await releasing
    expect(child.postMessage).not.toHaveBeenCalled()
    expect(child.kill).not.toHaveBeenCalled()
    expect(electron.utilityProcess.fork).not.toHaveBeenCalled()
  })

  it('reports an unconfirmed termination and never risks a second native recognizer', async () => {
    vi.useFakeTimers()
    const status = api.parakeetAddonError()
    await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalled())
    const probe = child.postMessage.mock.calls[0][0] as { id: string }
    child.emit('message', { type: 'result', id: probe.id })
    await status
    child.kill.mockReturnValue(false)

    const releasing = api.parakeetRelease()
    const releaseAssertion = expect(releasing).rejects.toThrow(/could not confirm/i)
    await vi.advanceTimersByTimeAsync(5_001)
    await releaseAssertion

    await expect(api.parakeetTranscribe(new Float32Array(16))).rejects.toThrow(/could not confirm/i)
    expect(electron.utilityProcess.fork).toHaveBeenCalledTimes(1)
  })

  it('does not let a stale released-child exit clear a newer generation termination failure', async () => {
    vi.useFakeTimers()
    const firstStatus = api.parakeetAddonError()
    await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalled())
    const firstProbe = child.postMessage.mock.calls[0][0] as { id: string }
    child.emit('message', { type: 'result', id: firstProbe.id })
    await firstStatus
    const firstRelease = api.parakeetRelease()
    child.emit('exit', 0)
    await firstRelease

    const secondChild = new FakeChild()
    electron.utilityProcess.fork.mockReturnValue(secondChild)
    const secondStatus = api.parakeetAddonError()
    await vi.waitFor(() => expect(secondChild.postMessage).toHaveBeenCalled())
    const secondProbe = secondChild.postMessage.mock.calls[0][0] as { id: string }
    secondChild.emit('message', { type: 'result', id: secondProbe.id })
    await secondStatus
    secondChild.kill.mockReturnValue(false)

    const secondRelease = api.parakeetRelease()
    const releaseAssertion = expect(secondRelease).rejects.toThrow(/could not confirm/i)
    await vi.advanceTimersByTimeAsync(5_001)
    await releaseAssertion
    child.emit('exit', 0)

    await expect(api.parakeetTranscribe(new Float32Array(16))).rejects.toThrow(/could not confirm/i)
    expect(electron.utilityProcess.fork).toHaveBeenCalledTimes(2)
  })
})
