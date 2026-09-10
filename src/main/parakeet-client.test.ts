import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class FakeChild extends EventEmitter {
  readonly postMessage = vi.fn()
  readonly kill = vi.fn(() => true)
  readonly stderr = new EventEmitter()
  readonly stdout = new EventEmitter()
}

const electron = vi.hoisted(() => ({ utilityProcess: { fork: vi.fn() } }))
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
  new(byteLength: number, options: { maxByteLength: number }): ResizableArrayBuffer
  prototype: ResizableArrayBuffer
}
let api: Api
let child: FakeChild

async function waitForRequest(target: FakeChild, type: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 50; i++) {
    const found = target.postMessage.mock.calls.map(([m]) => m as Record<string, unknown>).find((m) => m.type === type)
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`fake Parakeet child never received ${type}`)
}

beforeEach(async () => {
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
    const requests = child.postMessage.mock.calls.map(([m]) => m as { type: string; id: string; pcm: ArrayBuffer })
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
    await Promise.resolve()

    await expect(api.parakeetTranscribe(new Float32Array(1))).rejects.toMatchObject({
      name: 'ParakeetBusyError',
      code: 'PARAKEET_BUSY',
      message: expect.stringMatching(/busy.*retry/i)
    })
    const requests = child.postMessage.mock.calls.map(([message]) => message as { type: string; id: string })
      .filter((message) => message.type === 'transcribe')
    expect(requests).toHaveLength(2)

    child.emit('message', { type: 'result', id: requests[0].id, text: 'first' })
    await expect(first).resolves.toBe('first')
    const third = api.parakeetTranscribe(new Float32Array(1))
    for (let i = 0; i < 50 && child.postMessage.mock.calls.length < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const allRequests = child.postMessage.mock.calls.map(([message]) => message as { type: string; id: string })
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
    await Promise.resolve()
    expect(child.postMessage).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(120_001)
    await timeoutAssertion
    expect(child.kill).toHaveBeenCalledTimes(1)

    const secondChild = new FakeChild()
    electron.utilityProcess.fork.mockReturnValue(secondChild)
    const waiting = api.parakeetTranscribe(new Float32Array(16))
    await Promise.resolve()
    expect(electron.utilityProcess.fork).toHaveBeenCalledTimes(1)
    child.emit('exit', 0)
    await Promise.resolve()
    await Promise.resolve()
    expect(electron.utilityProcess.fork).toHaveBeenCalledTimes(2)

    const request = secondChild.postMessage.mock.calls[0][0] as { id: string }
    secondChild.emit('message', { type: 'result', id: request.id, text: 'after timeout' })
    await expect(waiting).resolves.toBe('after timeout')
  })

  it('release resolves only after the exact child exits and blocks a second recognizer generation', async () => {
    const warm = api.ensureParakeetModel()
    const warmRequest = await waitForRequest(child, 'warmup')
    child.emit('message', { type: 'result', id: warmRequest.id })
    await warm

    let released = false
    const releasing = api.parakeetRelease().then(() => { released = true })
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

  it('does not admit a request that was awaiting its generation when release starts', async () => {
    const racing = api.parakeetTranscribe(new Float32Array(16))
    const releasing = api.parakeetRelease()
    await Promise.resolve()

    expect(child.postMessage).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledTimes(1)

    const secondChild = new FakeChild()
    electron.utilityProcess.fork.mockReturnValue(secondChild)
    child.emit('exit', 0)
    await releasing
    const request = await waitForRequest(secondChild, 'transcribe')
    secondChild.emit('message', { type: 'result', id: request.id, text: 'admitted after exit' })
    await expect(racing).resolves.toBe('admitted after exit')
  })

  it('reports an unconfirmed termination and never risks a second native recognizer', async () => {
    vi.useFakeTimers()
    const status = api.parakeetAddonError()
    await Promise.resolve()
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
    await Promise.resolve()
    const firstProbe = child.postMessage.mock.calls[0][0] as { id: string }
    child.emit('message', { type: 'result', id: firstProbe.id })
    await firstStatus
    const firstRelease = api.parakeetRelease()
    child.emit('exit', 0)
    await firstRelease

    const secondChild = new FakeChild()
    electron.utilityProcess.fork.mockReturnValue(secondChild)
    const secondStatus = api.parakeetAddonError()
    await Promise.resolve()
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
