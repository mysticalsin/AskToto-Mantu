import { describe, expect, it, vi } from 'vitest'
import { attachSpeakerEmbeddingHost, type SpeakerEmbeddingHostPort } from './speaker-embedding-host'

class FakePort implements SpeakerEmbeddingHostPort {
  listener: ((event: { data?: unknown } | unknown) => void) | null = null
  readonly postMessage = vi.fn()
  readonly start = vi.fn()
  on(_event: 'message', listener: (event: { data?: unknown } | unknown) => void): void {
    this.listener = listener
  }
  send(data: unknown): void {
    this.listener?.({ data })
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('speaker embedding utility host', () => {
  it('loads and constructs sherpa lazily in the child and preserves the non-external-buffer flag', async () => {
    const port = new FakePort()
    const compute = vi.fn(() => Float32Array.from({ length: 512 }, (_, i) => i / 512))
    const acceptWaveform = vi.fn()
    const extractor = { createStream: vi.fn(() => ({ acceptWaveform })), compute }
    const SpeakerEmbeddingExtractor = vi.fn(class {
      createStream = extractor.createStream
      compute = extractor.compute
    })
    const loadSherpa = vi.fn(() => ({ SpeakerEmbeddingExtractor }))
    attachSpeakerEmbeddingHost(port, { loadSherpa })

    expect(loadSherpa).not.toHaveBeenCalled()
    port.send({ type: 'embed', id: 'g1:r1', model: '/model.onnx', pcm: Float32Array.from([0.2]).buffer })
    await flush()

    expect(SpeakerEmbeddingExtractor).toHaveBeenCalledWith({ model: '/model.onnx', numThreads: 1, provider: 'cpu' })
    expect(acceptWaveform).toHaveBeenCalledWith({ samples: expect.any(Float32Array), sampleRate: 16_000 })
    expect(compute).toHaveBeenCalledWith(expect.anything(), false)
    const response = port.postMessage.mock.calls[0][0] as { embedding: ArrayBuffer }
    expect(Array.from(new Float32Array(response.embedding))).toHaveLength(512)
  })

  it.each([
    ['wrong dimension', new Float32Array(511)],
    ['non-finite output', Float32Array.from({ length: 512 }, (_, i) => i === 9 ? Number.NaN : 0)]
  ])('rejects %s instead of returning a corrupt successful embedding', async (_label, output) => {
    const port = new FakePort()
    attachSpeakerEmbeddingHost(port, {
      loadSherpa: () => ({
        SpeakerEmbeddingExtractor: class {
          createStream() { return { acceptWaveform() {} } }
          compute() { return output }
        }
      }),
      logError: vi.fn()
    })
    port.send({ type: 'embed', id: 'g1:r1', model: '/model.onnx', pcm: new Float32Array(1).buffer })
    await flush()
    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', id: 'g1:r1' }))
  })

  it('rejects malformed PCM before loading the native runtime', async () => {
    const port = new FakePort()
    const loadSherpa = vi.fn()
    attachSpeakerEmbeddingHost(port, { loadSherpa, logError: vi.fn() })
    port.send({ type: 'embed', id: 'bad', model: '/model.onnx', pcm: Float32Array.from([Number.NaN]).buffer })
    await flush()
    expect(loadSherpa).not.toHaveBeenCalled()
    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', id: 'bad' }))
  })

  it('serializes native compute and reports malformed/non-finite PCM as errors', async () => {
    const port = new FakePort()
    const order: number[] = []
    let release!: () => void
    const first = new Promise<void>((resolve) => { release = resolve })
    let call = 0
    attachSpeakerEmbeddingHost(port, {
      loadSherpa: () => ({
        SpeakerEmbeddingExtractor: class {
          createStream() { return { acceptWaveform() {} } }
          async compute(_stream: unknown, external: boolean) {
            expect(external).toBe(false)
            const n = ++call
            order.push(n)
            if (n === 1) await first
            return new Float32Array(512)
          }
        }
      }),
      logError: vi.fn()
    })
    port.send({ type: 'embed', id: 'one', model: '/model.onnx', pcm: new Float32Array(1).buffer })
    port.send({ type: 'embed', id: 'two', model: '/model.onnx', pcm: new Float32Array(1).buffer })
    await flush()
    expect(order).toEqual([1])
    release()
    await flush()
    expect(order).toEqual([1, 2])

    port.send({ type: 'embed', id: 'bad', model: '/model.onnx', pcm: Float32Array.from([Number.NaN]).buffer })
    await flush()
    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', id: 'bad' }))
  })
})
