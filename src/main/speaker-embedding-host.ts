/** Native speaker-embedding utility-process entry. No parent module may load sherpa. */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  SPEAKER_EMBEDDING_DIMENSIONS,
  SPEAKER_MAX_SAMPLES,
  SPEAKER_SAMPLE_RATE,
  type SpeakerEmbeddingHostRequest
} from './speaker-embedding-protocol'

export interface SpeakerEmbeddingHostPort {
  on(event: 'message', listener: (event: { data?: unknown } | unknown) => void): unknown
  postMessage(message: Record<string, unknown>): void
  start?(): void
}

interface HostDependencies {
  loadSherpa?: () => any
  logError?: (...args: unknown[]) => void
}

function defaultLoadSherpa(): any {
  // Deliberately inside this child-only entry: it owns the native addon and ONNX runtime.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('sherpa-onnx-node')
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function validModel(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export function attachSpeakerEmbeddingHost(
  port: SpeakerEmbeddingHostPort,
  dependencies: HostDependencies = {}
): void {
  const loadSherpa = dependencies.loadSherpa ?? defaultLoadSherpa
  const logError = dependencies.logError ?? console.error
  let sherpa: any | undefined
  let extractor: any | null = null
  let extractorModel: string | null = null
  let queue = Promise.resolve()

  function native(): any {
    if (sherpa === undefined) sherpa = loadSherpa()
    return sherpa
  }

  function getExtractor(model: string): any {
    if (extractor) {
      if (extractorModel !== model) throw new Error('Speaker embedding model changed while the helper was active.')
      return extractor
    }
    const sherpa = native()
    extractor = new sherpa.SpeakerEmbeddingExtractor({ model, numThreads: 1, provider: 'cpu' })
    extractorModel = model
    return extractor
  }

  async function handle(raw: unknown): Promise<void> {
    const request = raw as Partial<SpeakerEmbeddingHostRequest>
    if (!request || typeof request !== 'object' || typeof request.id !== 'string') return
    try {
      if ((request.type !== 'warmup' && request.type !== 'embed') || !validModel(request.model)) {
        throw new Error('Invalid speaker embedding request.')
      }
      if (request.type === 'warmup') {
        getExtractor(request.model)
        port.postMessage({ type: 'result', id: request.id })
        return
      }
      const pcm = (request as Partial<{ pcm: ArrayBuffer }>).pcm
      if (!(pcm instanceof ArrayBuffer) || pcm.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
        throw new Error('Speaker PCM must be an aligned Float32 buffer.')
      }
      const samples = new Float32Array(pcm)
      if (samples.length > SPEAKER_MAX_SAMPLES) throw new Error('Speaker PCM is too large.')
      for (const sample of samples) {
        if (!Number.isFinite(sample)) throw new Error('Speaker PCM samples must be finite.')
      }
      const nativeExtractor = getExtractor(request.model)
      const stream = nativeExtractor.createStream()
      stream.acceptWaveform({ samples, sampleRate: SPEAKER_SAMPLE_RATE })
      // MQA-237: false forces an ordinary copied ArrayBuffer; Electron forbids N-API external buffers.
      const result = await nativeExtractor.compute(stream, false) as Float32Array | number[]
      const embedding = result instanceof Float32Array ? new Float32Array(result) : Float32Array.from(result)
      if (embedding.length !== SPEAKER_EMBEDDING_DIMENSIONS) {
        throw new Error(`Speaker embedding must contain exactly ${SPEAKER_EMBEDDING_DIMENSIONS} values.`)
      }
      for (const value of embedding) {
        if (!Number.isFinite(value)) throw new Error('Speaker embedding values must be finite.')
      }
      port.postMessage({ type: 'result', id: request.id, embedding: embedding.buffer })
    } catch (error) {
      const detail = message(error)
      logError('[speaker-embedding-host]', detail)
      port.postMessage({ type: 'error', id: request.id, message: detail })
    }
  }

  port.on('message', (event) => {
    const raw = event && typeof event === 'object' && 'data' in event ? (event as { data: unknown }).data : event
    queue = queue.then(() => handle(raw), () => handle(raw))
  })
  port.start?.()
}

const parentPort = (process as NodeJS.Process & { parentPort?: SpeakerEmbeddingHostPort }).parentPort
if (parentPort) attachSpeakerEmbeddingHost(parentPort)
