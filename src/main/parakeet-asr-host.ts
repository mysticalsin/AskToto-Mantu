/**
 * Utility-process boundary for Parakeet. The sherpa native addon and its ONNX
 * weights live only in this process, isolated from both Electron's main loop
 * and the Whisper/transformers native runtime.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const SAMPLE_RATE = 16_000
const MAX_SAMPLES = SAMPLE_RATE * 30

interface ModelFiles {
  encoder: string
  decoder: string
  joiner: string
  tokens: string
}

type HostRequest =
  | { type: 'probe'; id: string }
  | { type: 'warmup'; id: string; files: ModelFiles }
  | { type: 'transcribe'; id: string; files: ModelFiles; pcm: ArrayBuffer }

export interface ParakeetHostPort {
  on(event: 'message', listener: (event: { data?: unknown } | unknown) => void): unknown
  postMessage(message: Record<string, unknown>): void
  start?(): void
}

interface HostDependencies {
  loadSherpa?: () => any
  logError?: (...args: unknown[]) => void
}

function defaultLoadSherpa(): any {
  // Kept inside the utility-process entry: the parent bundle must never load
  // sherpa or its platform ONNX runtime.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('sherpa-onnx-node')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function validFiles(value: unknown): value is ModelFiles {
  if (!value || typeof value !== 'object') return false
  const files = value as Partial<ModelFiles>
  return [files.encoder, files.decoder, files.joiner, files.tokens].every(
    (file) => typeof file === 'string' && file.length > 0
  )
}

export function attachParakeetHost(port: ParakeetHostPort, dependencies: HostDependencies = {}): void {
  const loadSherpa = dependencies.loadSherpa ?? defaultLoadSherpa
  const logError = dependencies.logError ?? console.error
  let sherpa: any | undefined
  let recognizer: any | null = null
  let recognizerKey: string | null = null
  let queue = Promise.resolve()

  function addon(): any {
    if (sherpa === undefined) sherpa = loadSherpa()
    return sherpa
  }

  function getRecognizer(files: ModelFiles): any {
    const key = JSON.stringify(files)
    if (recognizer) {
      if (recognizerKey !== key) throw new Error('Parakeet model files changed while the helper was active.')
      return recognizer
    }
    const native = addon()
    recognizer = new native.OfflineRecognizer({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: { encoder: files.encoder, decoder: files.decoder, joiner: files.joiner },
        tokens: files.tokens,
        numThreads: 2,
        provider: 'cpu',
        modelType: 'nemo_transducer',
        debug: 0
      },
      decodingMethod: 'greedy_search'
    })
    recognizerKey = key
    return recognizer
  }

  async function handle(raw: unknown): Promise<void> {
    const request = raw as Partial<HostRequest>
    if (!request || typeof request !== 'object' || typeof request.id !== 'string') return
    try {
      if (request.type === 'probe') {
        addon()
        port.postMessage({ type: 'result', id: request.id })
        return
      }
      if ((request.type !== 'warmup' && request.type !== 'transcribe') || !validFiles(request.files)) {
        throw new Error('Invalid Parakeet request.')
      }
      if (request.type === 'warmup') {
        getRecognizer(request.files)
        port.postMessage({ type: 'result', id: request.id })
        return
      }
      const pcm = (request as Partial<{ pcm: ArrayBuffer }>).pcm
      if (!(pcm instanceof ArrayBuffer) || pcm.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
        throw new Error('Parakeet PCM must be an aligned Float32 buffer.')
      }
      const samples = new Float32Array(pcm)
      if (samples.length > MAX_SAMPLES) throw new Error('Parakeet PCM is too large.')
      for (const sample of samples) {
        if (!Number.isFinite(sample)) throw new Error('Parakeet PCM samples must be finite.')
      }
      const rec = getRecognizer(request.files)
      const stream = rec.createStream()
      stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE })
      await rec.decodeAsync(stream)
      const result = rec.getResult(stream)
      port.postMessage({ type: 'result', id: request.id, text: String(result?.text ?? '').trim() })
    } catch (error) {
      const message = errorMessage(error)
      logError('[parakeet-asr-host]', message)
      port.postMessage({ type: 'error', id: request.id, message })
    }
  }

  port.on('message', (event) => {
    const raw = event && typeof event === 'object' && 'data' in event ? (event as { data: unknown }).data : event
    queue = queue.then(() => handle(raw), () => handle(raw))
  })
  port.start?.()
}

const parentPort = (process as NodeJS.Process & { parentPort?: ParakeetHostPort }).parentPort
if (parentPort) attachParakeetHost(parentPort)
