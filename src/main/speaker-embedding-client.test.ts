import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class FakeChild extends EventEmitter {
  readonly postMessage = vi.fn()
  readonly kill = vi.fn(() => true)
  readonly stderr = new EventEmitter()
  readonly stdout = new EventEmitter()
}

const electron = vi.hoisted(() => ({ utilityProcess: { fork: vi.fn() } }))
vi.mock('electron', () => electron)
vi.mock('./logger', () => ({ mainLog: { warn: vi.fn(), error: vi.fn() } }))

let child: FakeChild
let api: typeof import('./speaker-embedding-client')

async function request(type = 'embed', target = child): Promise<Record<string, unknown>> {
  for (let i = 0; i < 20; i++) {
    const found = target.postMessage.mock.calls.map((call) => call[0] as Record<string, unknown>).find((m) => m.type === type)
    if (found) return found
    await Promise.resolve()
  }
  throw new Error(`No ${type} request posted`)
}

beforeEach(async () => {
  vi.resetModules()
  child = new FakeChild()
  electron.utilityProcess.fork.mockReset().mockReturnValue(child)
  api = await import('./speaker-embedding-client')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('speaker embedding utility client', () => {
  it('forks the dedicated host lazily and preserves the caller buffer', async () => {
    const samples = Float32Array.from([0.25, -0.5])
    const original = [...samples]
    expect(electron.utilityProcess.fork).not.toHaveBeenCalled()
    const pending = api.computeSpeakerEmbedding('/model.onnx', samples, 'live')
    const sent = await request()
    expect(electron.utilityProcess.fork.mock.calls[0][0]).toMatch(/speaker-embedding-host\.js$/)
    expect(sent.pcm).not.toBe(samples.buffer)
    child.emit('message', { type: 'result', id: sent.id, embedding: new Float32Array(512).buffer })
    await expect(pending).resolves.toHaveLength(512)
    expect([...samples]).toEqual(original)
  })

  it('validates finite and maximum PCM before spawning', async () => {
    await expect(api.computeSpeakerEmbedding('/model.onnx', Float32Array.from([Number.NaN]), 'live')).rejects.toThrow(/finite/i)
    await expect(api.computeSpeakerEmbedding('/model.onnx', new Float32Array(16_000 * 30 + 1), 'live')).rejects.toThrow(/large/i)
    expect(electron.utilityProcess.fork).not.toHaveBeenCalled()
  })

  it('bounds aggregate admitted PCM before allocating/posting and releases capacity exactly once', async () => {
    const max = new Float32Array(16_000 * 30)
    const a = api.computeSpeakerEmbedding('/model.onnx', max, 'live')
    const first = await request()
    const b = api.computeSpeakerEmbedding('/model.onnx', max, 'live')
    for (let i = 0; i < 5; i++) await Promise.resolve()
    await expect(api.computeSpeakerEmbedding('/model.onnx', new Float32Array(1), 'live')).rejects.toMatchObject({ code: 'SPEAKER_EMBEDDING_BUSY' })
    expect(child.postMessage).toHaveBeenCalledTimes(2)
    child.emit('message', { type: 'result', id: first.id, embedding: new Float32Array(512).buffer })
    await a
    const third = api.computeSpeakerEmbedding('/model.onnx', new Float32Array(1), 'live')
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(child.postMessage).toHaveBeenCalledTimes(3)
    for (const call of child.postMessage.mock.calls.slice(1)) {
      const sent = call[0] as { id: string }
      child.emit('message', { type: 'result', id: sent.id, embedding: new Float32Array(512).buffer })
    }
    await Promise.all([b, third])
  })

  it('bounds non-PCM warmup requests as well as bytes', async () => {
    const pending = Array.from({ length: 16 }, () => api.speakerEmbeddingAvailable('/model.onnx', 'live'))
    for (let i = 0; i < 20 && child.postMessage.mock.calls.length < 16; i++) await Promise.resolve()
    expect(child.postMessage).toHaveBeenCalledTimes(16)
    await expect(api.speakerEmbeddingAvailable('/model.onnx', 'live')).rejects.toMatchObject({ code: 'SPEAKER_EMBEDDING_BUSY' })
    for (const [sent] of child.postMessage.mock.calls) {
      child.emit('message', { type: 'result', id: (sent as { id: string }).id })
    }
    await expect(Promise.all(pending)).resolves.toEqual(Array(16).fill(true))
  })

  it('uses immutable byte accounting when the caller detaches its original buffer', async () => {
    const samples = new Float32Array(16_000 * 30)
    const pending = api.computeSpeakerEmbedding('/model.onnx', samples, 'live')
    const sent = await request()
    structuredClone(samples.buffer, { transfer: [samples.buffer] })
    child.emit('message', { type: 'result', id: sent.id, embedding: new Float32Array(512).buffer })
    await pending

    child.postMessage.mockClear()
    const next = api.computeSpeakerEmbedding('/model.onnx', new Float32Array(16_000 * 30), 'live')
    const nextSent = await request('embed')
    child.emit('message', { type: 'result', id: nextSent.id, embedding: new Float32Array(512).buffer })
    await next
  })

  it('uses immutable byte accounting when a resizable caller buffer shrinks', async () => {
    const bytes = 16_000 * 30 * Float32Array.BYTES_PER_ELEMENT
    const ResizableArrayBuffer = ArrayBuffer as unknown as {
      new(byteLength: number, options: { maxByteLength: number }): ArrayBuffer & { resize(size: number): void }
    }
    const buffer = new ResizableArrayBuffer(bytes, { maxByteLength: bytes })
    const samples = new Float32Array(buffer)
    const pending = api.computeSpeakerEmbedding('/model.onnx', samples, 'live')
    const sent = await request()
    buffer.resize(0)
    child.emit('message', { type: 'result', id: sent.id, embedding: new Float32Array(512).buffer })
    await pending

    child.postMessage.mockClear()
    const a = api.computeSpeakerEmbedding('/model.onnx', new Float32Array(16_000 * 30), 'live')
    const b = api.computeSpeakerEmbedding('/model.onnx', new Float32Array(16_000 * 30), 'live')
    for (let i = 0; i < 20 && child.postMessage.mock.calls.length < 2; i++) await Promise.resolve()
    expect(child.postMessage).toHaveBeenCalledTimes(2)
    for (const [request] of child.postMessage.mock.calls) {
      child.emit('message', { type: 'result', id: (request as { id: string }).id, embedding: new Float32Array(512).buffer })
    }
    await Promise.all([a, b])
  })

  it('rejects malformed host embeddings, crashes, and timed-out work', async () => {
    const malformed = api.computeSpeakerEmbedding('/model.onnx', new Float32Array(1), 'live')
    const malformedReq = await request()
    child.emit('message', { type: 'result', id: malformedReq.id, embedding: new Float32Array(2).buffer })
    await expect(malformed).rejects.toThrow(/512/)

    const crashed = api.computeSpeakerEmbedding('/model.onnx', new Float32Array(1), 'live')
    await request()
    child.emit('exit', 137)
    await expect(crashed).rejects.toThrow(/exited unexpectedly/i)
  })

  it('times out a hung request and terminates that exact generation', async () => {
    vi.useFakeTimers()
    const pending = api.computeSpeakerEmbedding('/model.onnx', new Float32Array(1), 'live')
    await request()
    const assertion = expect(pending).rejects.toThrow(/timed out/i)
    await vi.advanceTimersByTimeAsync(15_001)
    await assertion
    expect(child.kill).toHaveBeenCalledTimes(1)
    child.emit('exit', 0)
  })

  it('waits for exact exit, blocks overlap on unconfirmed exit, and ignores stale exits', async () => {
    vi.useFakeTimers()
    const warm = api.speakerEmbeddingAvailable('/model.onnx', 'live')
    const warmReq = await request('warmup')
    child.emit('message', { type: 'result', id: warmReq.id })
    await expect(warm).resolves.toBe(true)

    let settled = false
    const release = api.releaseSpeakerEmbedding('live').then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(child.kill).toHaveBeenCalledTimes(1)
    child.emit('exit', 0)
    await release

    const second = new FakeChild()
    electron.utilityProcess.fork.mockReturnValue(second)
    const secondWarm = api.speakerEmbeddingAvailable('/model.onnx', 'live')
    const req = await request('warmup', second)
    second.emit('message', { type: 'result', id: req.id })
    await secondWarm
    const failedRelease = api.releaseSpeakerEmbedding('live')
    const assertion = expect(failedRelease).rejects.toThrow(/could not confirm/i)
    await vi.advanceTimersByTimeAsync(5_001)
    await assertion
    child.emit('exit', 0)
    await expect(api.computeSpeakerEmbedding('/model.onnx', new Float32Array(1), 'live')).rejects.toThrow(/could not confirm/i)
    expect(electron.utilityProcess.fork).toHaveBeenCalledTimes(2)
  })

  it('waits for the other owner before killing, then confirms the exact child exit', async () => {
    const importing = api.computeSpeakerEmbedding('/model.onnx', new Float32Array(4), 'import')
    const req = await request()
    let settled = false
    const release = api.releaseSpeakerEmbedding('live').then((result) => { settled = true; return result })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(child.kill).not.toHaveBeenCalled()
    child.emit('message', { type: 'result', id: req.id, embedding: new Float32Array(512).buffer })
    await importing
    for (let i = 0; i < 5 && child.kill.mock.calls.length === 0; i++) await Promise.resolve()
    expect(child.kill).toHaveBeenCalledTimes(1)
    child.emit('exit', 0)
    await expect(release).resolves.toBe('released')
  })

  it('does not let later other-owner admission extend or get killed by an older release', async () => {
    const original = api.computeSpeakerEmbedding('/model.onnx', new Float32Array(4), 'import')
    const originalReq = await request()
    let releaseResult: string | undefined
    const oldStop = api.releaseSpeakerEmbedding('live').then((result) => {
      releaseResult = result
      return result
    })

    const replacement = api.computeSpeakerEmbedding('/model.onnx', new Float32Array(4), 'import')
    for (let i = 0; i < 20 && child.postMessage.mock.calls.length < 2; i++) await Promise.resolve()
    const replacementReq = child.postMessage.mock.calls[1][0] as { id: string }

    child.emit('message', { type: 'result', id: originalReq.id, embedding: new Float32Array(512).buffer })
    await original
    for (let i = 0; i < 20 && releaseResult === undefined; i++) await Promise.resolve()

    // The release owns only the work admitted when it began. A newer import request supersedes it;
    // waiting for global future idleness would leave this unset until replacement also finishes.
    expect(releaseResult).toBe('superseded')
    expect(child.kill).not.toHaveBeenCalled()

    child.emit('message', { type: 'result', id: replacementReq.id, embedding: new Float32Array(512).buffer })
    await replacement
    await expect(oldStop).resolves.toBe('superseded')
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('does not let an old teardown kill work admitted by a replacement session', async () => {
    const importing = api.computeSpeakerEmbedding('/model.onnx', new Float32Array(4), 'import')
    const importReq = await request()
    const oldStop = api.releaseSpeakerEmbedding('live')
    const replacement = api.computeSpeakerEmbedding('/model.onnx', new Float32Array(4), 'live')
    for (let i = 0; i < 20 && child.postMessage.mock.calls.length < 2; i++) await Promise.resolve()
    const liveReq = child.postMessage.mock.calls[1][0] as { id: string }

    child.emit('message', { type: 'result', id: importReq.id, embedding: new Float32Array(512).buffer })
    await importing
    await expect(oldStop).resolves.toBe('superseded')
    expect(child.kill).not.toHaveBeenCalled()

    child.emit('message', { type: 'result', id: liveReq.id, embedding: new Float32Array(512).buffer })
    await replacement
    const finalRelease = api.releaseSpeakerEmbedding('live')
    child.emit('exit', 0)
    await finalRelease
  })
})
