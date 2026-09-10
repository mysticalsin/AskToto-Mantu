import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { attachParakeetHost, type ParakeetHostPort } from './parakeet-asr-host'

class FakePort extends EventEmitter implements ParakeetHostPort {
  readonly sent: Array<Record<string, unknown>> = []
  postMessage(message: Record<string, unknown>): void {
    this.sent.push(message)
  }
  start(): void {}
}

const files = {
  encoder: '/models/encoder.int8.onnx',
  decoder: '/models/decoder.int8.onnx',
  joiner: '/models/joiner.int8.onnx',
  tokens: '/models/tokens.txt'
}

async function waitForCount(port: FakePort, count: number): Promise<void> {
  for (let i = 0; i < 50 && port.sent.length < count; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('parakeet-asr-host native boundary', () => {
  it('probe loads the addon but never constructs model weights', async () => {
    const port = new FakePort()
    const construct = vi.fn()
    const loadSherpa = vi.fn(() => ({ OfflineRecognizer: construct }))
    attachParakeetHost(port, { loadSherpa, logError: vi.fn() })

    port.emit('message', { data: { type: 'probe', id: 'g1:r1' } })
    await waitForCount(port, 1)

    expect(loadSherpa).toHaveBeenCalledTimes(1)
    expect(construct).not.toHaveBeenCalled()
    expect(port.sent[0]).toEqual({ type: 'result', id: 'g1:r1' })
  })

  it('serializes construction and decode in request order, constructs once, and trims only real text', async () => {
    const port = new FakePort()
    const events: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    class Recognizer {
      createStream() {
        const stream: {
          samples: Float32Array<ArrayBufferLike>
          acceptWaveform: (input: { samples: Float32Array<ArrayBufferLike> }) => void
        } = {
          samples: new Float32Array(),
          acceptWaveform: ({ samples }) => { stream.samples = samples }
        }
        return stream
      }
      async decodeAsync(stream: { samples: Float32Array }) {
        events.push(`start:${stream.samples[0]}`)
        if (stream.samples[0] === 1) await firstGate
        events.push(`end:${stream.samples[0]}`)
      }
      getResult(stream: { samples: Float32Array }) {
        return { text: stream.samples[0] === 1 ? '  hello  ' : '' }
      }
    }
    const construct = vi.fn(function () { return new Recognizer() })
    attachParakeetHost(port, { loadSherpa: () => ({ OfflineRecognizer: construct }), logError: vi.fn() })

    port.emit('message', { data: { type: 'transcribe', id: 'g1:r1', files, pcm: Float32Array.from([1]).buffer } })
    port.emit('message', { data: { type: 'transcribe', id: 'g1:r2', files, pcm: Float32Array.from([2]).buffer } })
    for (let i = 0; i < 50 && events.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 0))
    expect(events).toEqual(['start:1'])
    releaseFirst()
    await waitForCount(port, 2)

    expect(events).toEqual(['start:1', 'end:1', 'start:2', 'end:2'])
    expect(construct).toHaveBeenCalledTimes(1)
    expect(port.sent).toEqual([
      { type: 'result', id: 'g1:r1', text: 'hello' },
      { type: 'result', id: 'g1:r2', text: '' }
    ])
  })

  it('reports native construction and decode failures per request instead of returning false silence', async () => {
    const constructPort = new FakePort()
    attachParakeetHost(constructPort, {
      loadSherpa: () => ({ OfflineRecognizer: class { constructor() { throw new Error('Ort failed') } } }),
      logError: vi.fn()
    })
    constructPort.emit('message', { data: { type: 'warmup', id: 'g1:r1', files } })
    await waitForCount(constructPort, 1)
    expect(constructPort.sent[0]).toMatchObject({ type: 'error', id: 'g1:r1', message: 'Ort failed' })

    const decodePort = new FakePort()
    class BrokenRecognizer {
      createStream() { return { acceptWaveform: () => {} } }
      async decodeAsync() { throw new Error('decode failed') }
      getResult() { return { text: '' } }
    }
    attachParakeetHost(decodePort, {
      loadSherpa: () => ({ OfflineRecognizer: class { constructor() { return new BrokenRecognizer() } } }),
      logError: vi.fn()
    })
    decodePort.emit('message', { data: { type: 'transcribe', id: 'g1:r2', files, pcm: new Float32Array(1).buffer } })
    await waitForCount(decodePort, 1)
    expect(decodePort.sent[0]).toMatchObject({ type: 'error', id: 'g1:r2', message: 'decode failed' })
  })

  it('rejects malformed or oversized PCM at the child boundary', async () => {
    const port = new FakePort()
    attachParakeetHost(port, { loadSherpa: vi.fn(), logError: vi.fn() })
    port.emit('message', { data: { type: 'transcribe', id: 'g1:r1', files, pcm: new ArrayBuffer(3) } })
    port.emit('message', { data: { type: 'transcribe', id: 'g1:r2', files, pcm: new ArrayBuffer((16_000 * 30 + 1) * 4) } })
    await waitForCount(port, 2)
    expect(port.sent[0]).toMatchObject({ type: 'error', id: 'g1:r1' })
    expect(port.sent[1]).toMatchObject({ type: 'error', id: 'g1:r2' })
  })
})
