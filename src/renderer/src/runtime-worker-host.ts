import { isWhisperLanguageName } from '@shared/lang-id'

type HostConfig = {
  readonly type: 'configure'
  readonly token: string
  readonly workerPath: string
  readonly modelRoot: string
  readonly wasmRoot: string
}

type WorkerRequest =
  | {
      readonly type: 'init'
      readonly quality?: 'best' | 'fast'
      readonly language?: string
      readonly resetFollow?: boolean
    }
  | { readonly type: 'pinLanguage'; readonly language: string }
  | {
      readonly type: 'audio'
      readonly audio: Float32Array
      readonly speaker: 'you' | 'them'
      readonly partial?: boolean
    }

const SAFE_RELATIVE = /^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/
const validLanguage = (value: unknown): value is string =>
  value === 'auto' || (typeof value === 'string' && isWhisperLanguageName(value))
const MAX_AUDIO_SAMPLES = 480_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...allowed].sort().join(',')
}

function validConfig(value: unknown): value is HostConfig {
  if (!isRecord(value)) return false
  return (
    exactKeys(value, ['type', 'token', 'workerPath', 'modelRoot', 'wasmRoot']) &&
    value.type === 'configure' &&
    typeof value.token === 'string' &&
    /^[0-9a-f]{64}$/.test(value.token) &&
    typeof value.workerPath === 'string' &&
    SAFE_RELATIVE.test(value.workerPath) &&
    typeof value.modelRoot === 'string' &&
    SAFE_RELATIVE.test(value.modelRoot) &&
    typeof value.wasmRoot === 'string' &&
    SAFE_RELATIVE.test(value.wasmRoot)
  )
}

function validateRequest(value: unknown): value is WorkerRequest {
  if (!isRecord(value)) return false
  if (value.type === 'init') {
    if (!exactKeys(value, ['type', ...['quality', 'language', 'resetFollow', 'bundled'].filter((key) => key in value)]))
      return false
    return (
      (value.quality === undefined || value.quality === 'best' || value.quality === 'fast') &&
      (value.language === undefined || validLanguage(value.language)) &&
      (value.resetFollow === undefined || typeof value.resetFollow === 'boolean') &&
      (value.bundled === undefined || typeof value.bundled === 'boolean') &&
      value.runtimeBase === undefined
    )
  }
  if (value.type === 'pinLanguage') {
    return exactKeys(value, ['type', 'language']) && validLanguage(value.language)
  }
  if (value.type === 'audio') {
    return (
      exactKeys(value, ['type', 'audio', 'speaker', ...('partial' in value ? ['partial'] : [])]) &&
      value.audio instanceof Float32Array &&
      value.audio.length > 0 &&
      value.audio.length <= MAX_AUDIO_SAMPLES &&
      (value.speaker === 'you' || value.speaker === 'them') &&
      (value.partial === undefined || typeof value.partial === 'boolean')
    )
  }
  return false
}

function sanitizeResponse(value: unknown): unknown | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null
  if (value.type === 'ready' && (value.engine === 'wasm' || value.engine === 'webgpu')) {
    return {
      type: 'ready',
      engine: value.engine,
      requestedQuality: value.requestedQuality === 'fast' ? 'fast' : 'best',
      qualityDegraded: value.qualityDegraded === true
    }
  }
  if (
    value.type === 'progress' &&
    Number.isInteger(value.pct) &&
    (value.pct as number) >= 0 &&
    (value.pct as number) <= 100
  ) {
    return { type: 'progress', pct: value.pct }
  }
  if (
    value.type === 'text' &&
    typeof value.text === 'string' &&
    value.text.length <= 20_000 &&
    (value.speaker === 'you' || value.speaker === 'them')
  ) {
    return { type: 'text', text: value.text, speaker: value.speaker, partial: value.partial === true }
  }
  if (value.type === 'error') {
    if (value.speaker === 'you' || value.speaker === 'them') {
      return {
        type: 'error',
        message: 'Part of the audio could not be transcribed. Transcription is continuing.',
        speaker: value.speaker
      }
    }
    if (typeof value.message === 'string') {
      return { type: 'error', message: 'The offline speech runtime could not start.' }
    }
  }
  if (value.type === 'log') return null
  return null
}

let port: MessagePort | null = null
let worker: Worker | null = null
let resourceOrigin = ''
let modelRoot = ''
let wasmRoot = ''
let configured = false

function stop(): void {
  if (worker) worker.terminate()
  worker = null
  port?.close()
  port = null
  configured = false
}

function attachPort(received: MessagePort): void {
  if (port) {
    received.close()
    return
  }
  port = received
  port.onmessage = (event: MessageEvent<unknown>): void => {
    if (!configured) {
      if (!validConfig(event.data)) {
        stop()
        return
      }
      const config = event.data
      resourceOrigin = `metis-runtime://${config.token}/runtime`
      modelRoot = config.modelRoot
      wasmRoot = config.wasmRoot
      const workerUrl = `${resourceOrigin}/${config.workerPath}`
      try {
        worker = new Worker(workerUrl, { type: 'module', name: 'metis-offline-asr' })
      } catch {
        port?.postMessage({ type: 'error', message: 'The offline speech runtime could not start.' })
        stop()
        return
      }
      configured = true
      worker.onmessage = (workerEvent: MessageEvent<unknown>): void => {
        const safe = sanitizeResponse(workerEvent.data)
        if (safe !== null) port?.postMessage(safe)
      }
      worker.onerror = (): void => {
        port?.postMessage({ type: 'error', message: 'The offline speech runtime could not start.' })
      }
      return
    }
    if (!worker || !validateRequest(event.data)) return
    const message =
      event.data.type === 'init'
        ? {
            ...event.data,
            bundled: true,
            runtimeBase: `${resourceOrigin}/${modelRoot}`,
            wasmBase: `${resourceOrigin}/${wasmRoot}/`
          }
        : event.data
    worker.postMessage(message, event.data.type === 'audio' ? [event.data.audio.buffer] : [])
    if (event.data.type === 'pinLanguage') port?.postMessage({ type: 'control-settled' })
  }
  port.onmessageerror = stop
  port.start()
}

window.addEventListener('message', (event: MessageEvent<unknown>): void => {
  if (event.source !== window || !isRecord(event.data) || event.data.type !== 'metis-runtime-host-channel') return
  const received = event.ports[0]
  if (received) attachPort(received)
})

window.addEventListener('message', (event: MessageEvent<unknown>): void => {
  if (event.source === window && isRecord(event.data) && event.data.type === 'metis-runtime-host-stop') stop()
})
