import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PackageRuntimeContract } from './features/components/speech-pack/package-contract'

class FakeChild extends EventEmitter {
  readonly postMessage = vi.fn()
  readonly kill = vi.fn(() => true)
  readonly stderr = new EventEmitter()
  readonly stdout = new EventEmitter()
}

// These utility-host tests exercise the unconfigured development runtime boundary.
const electron = vi.hoisted(() => ({ app: { isPackaged: false }, utilityProcess: { fork: vi.fn() } }))
const paths = vi.hoisted(() => ({ model: '' }))

vi.mock('electron', () => electron)
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

const fullRuntime: PackageRuntimeContract = { status: 'legacy-full', profile: 'full', inventory: null }
const invalidRuntime: PackageRuntimeContract = {
  status: 'invalid',
  reason: 'inventory-invalid',
  profile: null,
  inventory: null
}

async function heldRuntimeAuthority() {
  const { configurePackageRuntimeContractProvider } = await import(
    './features/components/speech-pack/package-runtime-state'
  )
  let resolve!: (contract: PackageRuntimeContract) => void
  let next = new Promise<PackageRuntimeContract>((done) => {
    resolve = done
  })
  const provider = vi.fn(() => next)
  configurePackageRuntimeContractProvider(provider)
  electron.app.isPackaged = true
  return {
    provider,
    settle(contract: PackageRuntimeContract) {
      next = Promise.resolve(contract)
      resolve(contract)
    }
  }
}

async function settleHeldWork(authority: Awaited<ReturnType<typeof heldRuntimeAuthority>>, work: Promise<unknown>[]) {
  authority.settle(invalidRuntime)
  const stopping = api.parakeetRelease()
  const settled = Promise.allSettled([...work, stopping])
  child.emit('exit', 0)
  await settled
}

async function waitForRequest(target: FakeChild, type: string, occurrence = 1): Promise<Record<string, unknown>> {
  return vi.waitFor(() => {
    const found = target.postMessage.mock.calls
      .map(([m]) => m as Record<string, unknown>)
      .filter((m) => m.type === type)[occurrence - 1]
    expect(found, `fake Parakeet child must receive ${type} #${occurrence}`).toBeDefined()
    return found!
  })
}

beforeEach(async () => {
  electron.app.isPackaged = false
  paths.model = mkdtempSync(join(tmpdir(), 'metis-parakeet-client-'))
  mkdirSync(paths.model, { recursive: true })
  for (const name of ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']) {
    writeFileSync(join(paths.model, name), Buffer.alloc(2_048, 1))
  }
  child = new FakeChild()
  electron.utilityProcess.fork.mockReset().mockReturnValue(child)
  vi.resetModules()
  api = await import('./parakeet')
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(paths.model, { recursive: true, force: true })
})

describe('Parakeet utilityProcess client', () => {
  it.each([
    'mutate',
    'detach',
    'resize'
  ] as const)('snapshots PCM before held runtime authority when the caller immediately %ss its buffer', async (change) => {
    const authority = await heldRuntimeAuthority()
    const buffer = new ResizableBuffer(8, { maxByteLength: 8 })
    const samples = new Float32Array(buffer)
    samples.set([0.25, -0.5])
    const pending = api.parakeetTranscribe(samples)
    if (change === 'mutate') samples.fill(1)
    else if (change === 'detach') structuredClone(buffer, { transfer: [buffer] })
    else buffer.resize(0)
    try {
      expect(authority.provider).toHaveBeenCalledTimes(1)
      expect(electron.utilityProcess.fork).not.toHaveBeenCalled()
      authority.settle(fullRuntime)
      const sent = await waitForRequest(child, 'transcribe')
      child.emit('message', { type: 'result', id: sent.id, text: 'snapshot' })
      await expect(pending).resolves.toBe('snapshot')
      expect([...new Float32Array(sent.pcm as ArrayBuffer)]).toEqual([0.25, -0.5])
    } finally {
      await settleHeldWork(authority, [pending])
    }
  })

  it.each([
    'transcribe',
    'warmup',
    'probe'
  ] as const)('does not admit %s when release immediately wins over held runtime authority', async (kind) => {
    const authority = await heldRuntimeAuthority()
    const pending =
      kind === 'transcribe'
        ? api.parakeetTranscribe(new Float32Array(1))
        : kind === 'warmup'
          ? api.ensureParakeetModel()
          : api.parakeetAddonError()
    const stopping = api.parakeetRelease()
    try {
      await stopping
      expect(authority.provider).toHaveBeenCalledTimes(1)
      expect(electron.utilityProcess.fork).not.toHaveBeenCalled()
      const refused =
        kind === 'probe'
          ? expect(pending).resolves.toMatch(/cancelled/i)
          : expect(pending).rejects.toThrow(/cancelled/i)
      authority.settle(fullRuntime)
      await refused
      expect(child.postMessage).not.toHaveBeenCalled()
      expect(child.kill).not.toHaveBeenCalled()
      expect(electron.utilityProcess.fork).not.toHaveBeenCalled()
    } finally {
      await settleHeldWork(authority, [pending, stopping])
    }
  })

  it('reserves all sixteen request slots, including zero-byte work, before authority resolves', async () => {
    const authority = await heldRuntimeAuthority()
    const pending = Array.from({ length: 16 }, (_, index) =>
      index % 2 ? api.ensureParakeetModel() : api.parakeetTranscribe(new Float32Array(0))
    )
    try {
      await expect(api.parakeetTranscribe(new Float32Array(0))).rejects.toMatchObject({ code: 'PARAKEET_BUSY' })
      await expect(api.ensureParakeetModel()).rejects.toMatchObject({ code: 'PARAKEET_BUSY' })
      await expect(api.parakeetAddonError()).resolves.toMatch(/busy/i)
      expect(authority.provider).toHaveBeenCalledTimes(16)
      expect(electron.utilityProcess.fork).not.toHaveBeenCalled()
      const refused = Promise.allSettled(pending)
      authority.settle(invalidRuntime)
      expect((await refused).every((result) => result.status === 'rejected')).toBe(true)
      authority.settle(fullRuntime)
      const later = api.ensureParakeetModel()
      pending.push(later)
      const sent = await waitForRequest(child, 'warmup')
      child.emit('message', { type: 'result', id: sent.id })
      await expect(later).resolves.toBeUndefined()
    } finally {
      await settleHeldWork(authority, pending)
    }
  })

  it('holds immutable byte reservations through authority denial and restores them exactly once', async () => {
    const authority = await heldRuntimeAuthority()
    const windows = [new Float32Array(16_000 * 30), new Float32Array(16_000 * 30)]
    const pending = windows.map((samples) => api.parakeetTranscribe(samples))
    for (const samples of windows) structuredClone(samples.buffer, { transfer: [samples.buffer] })
    try {
      await expect(api.parakeetTranscribe(new Float32Array(1))).rejects.toMatchObject({ code: 'PARAKEET_BUSY' })
      expect(authority.provider).toHaveBeenCalledTimes(2)
      expect(electron.utilityProcess.fork).not.toHaveBeenCalled()
      const refused = Promise.allSettled(pending)
      authority.settle(invalidRuntime)
      expect((await refused).every((result) => result.status === 'rejected')).toBe(true)
      authority.settle(fullRuntime)
      pending.push(api.parakeetTranscribe(new Float32Array(16_000 * 30)))
      pending.push(api.parakeetTranscribe(new Float32Array(16_000 * 30)))
      await expect(api.parakeetTranscribe(new Float32Array(1))).rejects.toMatchObject({ code: 'PARAKEET_BUSY' })
      await waitForRequest(child, 'transcribe', 2)
      for (const [sent] of child.postMessage.mock.calls) {
        child.emit('message', { type: 'result', id: sent.id, text: 'capacity restored' })
      }
      await expect(Promise.all(pending.slice(2))).resolves.toEqual(['capacity restored', 'capacity restored'])
    } finally {
      await settleHeldWork(authority, pending)
    }
  })

  it('validates malformed PCM before authority but preserves valid-input runtime refusal', async () => {
    const authority = await heldRuntimeAuthority()
    await expect(api.parakeetTranscribe(Float32Array.from([NaN]))).rejects.toThrow(/finite/i)
    await expect(api.parakeetTranscribe(new Float32Array(16_000 * 30 + 1))).rejects.toThrow(/large/i)
    expect(authority.provider).not.toHaveBeenCalled()
    const pending = api.parakeetTranscribe(new Float32Array(1))
    try {
      const refused = expect(pending).rejects.toThrow(/optional asr runtime is not configured/i)
      authority.settle(invalidRuntime)
      await refused
      expect(child.postMessage).not.toHaveBeenCalled()
      expect(electron.utilityProcess.fork).not.toHaveBeenCalled()
    } finally {
      await settleHeldWork(authority, [pending])
    }
  })

  it('refuses an unconfigured packaged runtime before posting work or forking a child', async () => {
    electron.app.isPackaged = true

    await expect(api.parakeetAddonError()).resolves.toMatch(/optional asr runtime is not configured/i)
    await expect(api.ensureParakeetModel()).rejects.toThrow(/optional asr runtime is not configured/i)
    await expect(api.parakeetTranscribe(new Float32Array(16))).rejects.toThrow(
      /optional asr runtime is not configured/i
    )

    expect(child.postMessage).not.toHaveBeenCalled()
    expect(child.kill).not.toHaveBeenCalled()
    expect(electron.utilityProcess.fork).not.toHaveBeenCalled()
  })

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
    const firstRequest = await waitForRequest(child, 'transcribe')
    await waitForRequest(child, 'transcribe', 2)
    const requests = child.postMessage.mock.calls
      .map(([m]) => m as { type: string; id: string; pcm: ArrayBuffer })
      .filter((m) => m.type === 'transcribe')

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

  it('rejects non-finite and oversized PCM before forking a child', async () => {
    await expect(api.parakeetTranscribe(Float32Array.from([Number.NaN]))).rejects.toThrow(/finite/i)
    await expect(api.parakeetTranscribe(new Float32Array(16_000 * 30 + 1))).rejects.toThrow(/too large/i)
    expect(electron.utilityProcess.fork).not.toHaveBeenCalled()
  })

  it('bounds aggregate queued PCM and restores admission when one decode finishes', async () => {
    const maxWindow = new Float32Array(16_000 * 30)
    const first = api.parakeetTranscribe(maxWindow)
    const second = api.parakeetTranscribe(maxWindow)
    await waitForRequest(child, 'transcribe', 2)

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
    await waitForRequest(child, 'transcribe', 3)
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

    await waitForRequest(child, 'transcribe', 2)
    const requests = child.postMessage.mock.calls.map(([message]) => message as { id: string })
    child.emit('message', { type: 'result', id: requests[0].id, text: 'first' })
    child.emit('message', { type: 'result', id: requests[1].id, text: 'second' })
    await Promise.all(pending)

    const later = api.parakeetTranscribe(new Float32Array(1))
    await waitForRequest(child, 'transcribe', 3)
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

      await waitForRequest(child, 'transcribe', 2)
      const requests = child.postMessage.mock.calls.map(([message]) => message as { id: string })
      child.emit('message', { type: 'result', id: requests[0].id, text: 'first' })
      child.emit('message', { type: 'result', id: requests[1].id, text: 'second' })
      await Promise.all(pending)

      const later = api.parakeetTranscribe(new Float32Array(1))
      await waitForRequest(child, 'transcribe', 3)
      const laterRequest = child.postMessage.mock.calls[2][0] as { id: string }
      child.emit('message', { type: 'result', id: laterRequest.id, text: 'capacity restored' })
      await expect(later).resolves.toBe('capacity restored')
    }
  )

  it('bounds non-audio requests in the generation pending map', async () => {
    const warming = Array.from({ length: 16 }, () => api.ensureParakeetModel())
    await waitForRequest(child, 'warmup', 16)
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
    await waitForRequest(child, 'transcribe')
    expect(child.postMessage).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(120_001)
    await timeoutAssertion
    expect(child.kill).toHaveBeenCalledTimes(1)

    const secondChild = new FakeChild()
    electron.utilityProcess.fork.mockReturnValue(secondChild)
    const waiting = api.parakeetTranscribe(new Float32Array(16))
    expect(electron.utilityProcess.fork).toHaveBeenCalledTimes(1)
    child.emit('exit', 0)
    const request = await waitForRequest(secondChild, 'transcribe')
    expect(electron.utilityProcess.fork).toHaveBeenCalledTimes(2)
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
    const probe = await waitForRequest(child, 'probe')
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
    const firstProbe = await waitForRequest(child, 'probe')
    child.emit('message', { type: 'result', id: firstProbe.id })
    await firstStatus
    const firstRelease = api.parakeetRelease()
    child.emit('exit', 0)
    await firstRelease

    const secondChild = new FakeChild()
    electron.utilityProcess.fork.mockReturnValue(secondChild)
    const secondStatus = api.parakeetAddonError()
    const secondProbe = await waitForRequest(secondChild, 'probe')
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
