import type { SpeechRouteId } from './policy'
import { MAX_OUTPUT_FRAME_BYTES } from './limits'

export interface SpeechTransportConfig {
  accountId: string
  gatewayId: string
  routeId: SpeechRouteId
  modelId: string
  configVersion: string
  allowedLanguages: readonly string[]
  language?: string
  gatewayRunToken: string
  deepgramApiKey?: string
}

export type SpeechUpstreamResult =
  | {
      ok: true
      socket: WebSocket
    }
  | {
      ok: false
      code: 'UPSTREAM_UNAVAILABLE'
      definitelyClosed?: boolean
    }

export type SpeechProviderFrame =
  | {
      type: 'transcript'
      text: string
      startMs: number
      endMs: number
      final: boolean
      languages?: string[]
      words?: Array<{
        text: string
        punctuatedWord?: string
        startMs: number
        endMs: number
        language?: string
        speaker?: number
      }>
    }
  | { type: 'provider-complete' }
  | { type: 'error'; code: 'UPSTREAM_UNAVAILABLE' }

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/

export function buildSpeechUpstreamRequest(config: SpeechTransportConfig): Request {
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(config.accountId) ||
    !SAFE_ID.test(config.gatewayId) ||
    !config.configVersion ||
    !config.gatewayRunToken ||
    /[\r\n]/.test(config.gatewayRunToken)
  )
    throw new Error('speech transport configuration invalid')
  const url = new URL(
    `/v1/${encodeURIComponent(config.accountId)}/${encodeURIComponent(config.gatewayId)}`,
    'https://gateway.ai.cloudflare.com'
  )
  const headers = new Headers({
    upgrade: 'websocket',
    'cf-aig-authorization': `Bearer ${config.gatewayRunToken}`,
    'cf-aig-collect-log': 'false',
    'cf-aig-collect-log-payload': 'false'
  })
  if (config.routeId === 'deepgram-via-gateway' && config.modelId === 'nova-3') {
    if (!config.deepgramApiKey || /[\r\n]/.test(config.deepgramApiKey))
      throw new Error('speech credentials unavailable')
    url.pathname += '/deepgram/v1/listen'
    url.searchParams.set('model', 'nova-3')
    const language = config.language ?? 'multi'
    if (!config.allowedLanguages.includes(language)) throw new Error('speech language unavailable')
    url.searchParams.set('language', language)
    url.searchParams.set('encoding', 'linear16')
    url.searchParams.set('sample_rate', '16000')
    url.searchParams.set('channels', '1')
    url.searchParams.set('interim_results', 'true')
    url.searchParams.set('mip_opt_out', 'true')
    headers.set('authorization', `Token ${config.deepgramApiKey}`)
  } else if (config.routeId === 'workers-ai-nova3' && config.modelId === '@cf/deepgram/nova-3') {
    if (!config.language || !config.allowedLanguages.includes(config.language))
      throw new Error('speech language unavailable')
    url.pathname += '/workers-ai'
    url.searchParams.set('model', '@cf/deepgram/nova-3')
    url.searchParams.set('language', config.language)
    url.searchParams.set('encoding', 'linear16')
    url.searchParams.set('sample_rate', '16000')
    url.searchParams.set('interim_results', 'true')
  } else throw new Error('speech route unavailable')
  return new Request(url, { method: 'GET', headers, redirect: 'manual' })
}

export async function openSpeechUpstream(
  config: SpeechTransportConfig,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5_000
): Promise<SpeechUpstreamResult> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 5_000)
    return { ok: false, code: 'UPSTREAM_UNAVAILABLE' }
  let request: Request
  try {
    request = buildSpeechUpstreamRequest(config)
  } catch {
    return { ok: false, code: 'UPSTREAM_UNAVAILABLE' }
  }
  const controller = new AbortController()
  let rejectTimeout!: () => void
  let didTimeout = false
  const timeout = new Promise<never>((_, reject) => {
    rejectTimeout = () => reject(new Error('timeout'))
  })
  const timer = setTimeout(() => {
    didTimeout = true
    controller.abort()
    rejectTimeout()
  }, timeoutMs)
  try {
    const pending = Promise.resolve().then(() => fetchImpl(request, { signal: controller.signal }))
    void pending.then(
      (response) => {
        if (didTimeout) {
          const late = response as Response & { webSocket?: WebSocket }
          void late.body?.cancel().catch(() => undefined)
          try {
            late.webSocket?.close(1000, 'speech handshake timed out')
          } catch {
            /* ambiguous close remains charged */
          }
        }
      },
      () => undefined
    )
    const response = (await Promise.race([pending, timeout])) as Response & { webSocket?: WebSocket }
    if (response.status !== 101 || !response.webSocket) {
      void response.body?.cancel().catch(() => undefined)
      return { ok: false, code: 'UPSTREAM_UNAVAILABLE', definitelyClosed: response.status !== 101 }
    }
    response.webSocket.binaryType = 'arraybuffer'
    return { ok: true, socket: response.webSocket }
  } catch {
    return { ok: false, code: 'UPSTREAM_UNAVAILABLE', definitelyClosed: false }
  } finally {
    clearTimeout(timer)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function normalizeSpeechProviderFrame(raw: string): SpeechProviderFrame | null {
  if (raw.length === 0 || new TextEncoder().encode(raw).byteLength > MAX_OUTPUT_FRAME_BYTES) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  if (value.type === 'Error' || value.type === 'error') return { type: 'error', code: 'UPSTREAM_UNAVAILABLE' }
  if (value.type === 'Results' && isRecord(value.channel) && Array.isArray(value.channel.alternatives)) {
    const first = value.channel.alternatives[0]
    if (!isRecord(first) || typeof first.transcript !== 'string' || first.transcript.length > 16_384) return null
    const start = typeof value.start === 'number' && Number.isFinite(value.start) && value.start >= 0 ? value.start : 0
    const duration =
      typeof value.duration === 'number' && Number.isFinite(value.duration) && value.duration >= 0 ? value.duration : 0
    const startMs = Math.min(Number.MAX_SAFE_INTEGER, Math.floor(start * 1000))
    const endMs = Math.min(Number.MAX_SAFE_INTEGER, Math.floor((start + duration) * 1000))
    const validLanguage = (language: unknown): language is string =>
      typeof language === 'string' && language.length <= 35 && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language)
    const languages = Array.isArray(value.languages) ? value.languages.filter(validLanguage).slice(0, 8) : undefined
    const words = Array.isArray(first.words)
      ? first.words.slice(0, 64).flatMap((word) => {
          if (!isRecord(word) || typeof word.word !== 'string' || word.word.length > 256) return []
          const wordStart =
            typeof word.start === 'number' && Number.isFinite(word.start) && word.start >= 0
              ? Math.floor(word.start * 1000)
              : startMs
          const wordEnd =
            typeof word.end === 'number' && Number.isFinite(word.end) && word.end >= 0
              ? Math.floor(word.end * 1000)
              : wordStart
          const item: {
            text: string
            punctuatedWord?: string
            startMs: number
            endMs: number
            language?: string
            speaker?: number
          } = {
            text: word.word,
            startMs: Math.min(Number.MAX_SAFE_INTEGER, wordStart),
            endMs: Math.max(Math.min(Number.MAX_SAFE_INTEGER, wordStart), Math.min(Number.MAX_SAFE_INTEGER, wordEnd))
          }
          if (typeof word.punctuated_word === 'string' && word.punctuated_word.length <= 256)
            item.punctuatedWord = word.punctuated_word
          if (validLanguage(word.language)) item.language = word.language
          if (Number.isSafeInteger(word.speaker) && Number(word.speaker) >= 0 && Number(word.speaker) <= 1_000)
            item.speaker = Number(word.speaker)
          return [item]
        })
      : undefined
    return {
      type: 'transcript',
      text: first.transcript,
      startMs,
      endMs,
      final: value.is_final === true,
      ...(languages?.length ? { languages } : {}),
      ...(words?.length ? { words } : {})
    }
  }
  if (value.type === 'Metadata' || value.type === 'metadata') return { type: 'provider-complete' }
  return null
}
