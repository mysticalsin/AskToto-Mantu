/**
 * Cloud STT adapter (Métis 1.9.1 enterprise-live).
 *
 * Device capture stays local; inference is cloud. Under CLOUD_ONLY, local Whisper/
 * Parakeet/Apple must not boot as fallback — callers get an honest BLOCKED error.
 * Provider credentials stay server-side (Operator/gateway); this module is the
 * client contract + message normalizers + URL/start builders. Live WS attach: live-session.ts.
 *
 * Approved providers (skill ref 05): Soniox (cost-first benchmark) and
 * Cloudflare Nova-3 `@cf/deepgram/nova-3` (consolidated-vendor comparator).
 * No production default switch without approval + representative tests.
 */
import { createHash } from 'node:crypto'
import {
  assertCloudOnlyAllowsEngine,
  CLOUD_ONLY_LOCAL_FALLBACK_BLOCKED,
  isCloudOnlyProfile,
  type EnterpriseLiveProfile,
  resolveEnterpriseLiveProfile
} from '../../shared/enterprise-live-profile'
import {
  resolveNova3LanguageQuery,
  resolveNova3LanguageQueryPinned,
  resolveSonioxLanguageConfig,
  resolveSonioxLanguageConfigPinned,
  type Nova3LanguageQuery,
  type SonioxLanguageConfig
} from '../../shared/cloud-stt-language'
import type { CloudSttProviderId } from '../../shared/cloud-stt-provider'

/** Cloudflare Workers AI model id for Nova-3 (Deepgram). */
export const CLOUDFLARE_NOVA3_MODEL = '@cf/deepgram/nova-3'

export type CloudSttScope = {
  tenantId?: string
  meetingId?: string
  captureId?: string
  epoch?: string
  track?: string
}

export type CloudSttSessionConfig = {
  provider: CloudSttProviderId
  /** Meeting/capture scope for diarization cluster binding (not a voiceprint). */
  tenantId?: string
  meetingId?: string
  captureId?: string
  epoch?: string
  track?: string
  /** When true, managed profile refuses local ASR fallback. */
  profile?: EnterpriseLiveProfile
  /**
   * Settings.asrLanguage — 'auto' or a LANGUAGE_NAMES display name (e.g. 'French').
   * Wired into Nova-3 / Soniox so CLOUD_ONLY Listen is not stuck on Deepgram's English default.
   */
  asrLanguage?: string
}

export type CloudSttWord = {
  text: string
  startMs: number
  endMs: number
  isFinal: boolean
  language?: string
  /** Provider cluster id — not a person's name. */
  cluster?: string
}

export type CloudSttFinalSegment = {
  id: string
  text: string
  startMs: number
  endMs: number
  cluster: string
  language: string
  isFinal: true
  revision: number
}

export type CloudSttNormalizeResult = {
  finals: CloudSttFinalSegment[]
  interimText: string
  finished: boolean
}

export const CLOUD_STT_UNCONFIGURED =
  'Cloud STT is not configured. Set an approved provider (Cloudflare Nova-3 or Soniox) for this managed profile.'

export class CloudSttError extends Error {
  readonly code: string
  constructor(code: string, message?: string) {
    super(message || code)
    this.name = 'CloudSttError'
    this.code = code
  }
}

function nonNegative(n: unknown, code = 'INVALID_STT_TIME'): number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
    throw new CloudSttError(code)
  }
  return n
}

function clusterId(raw: unknown): string {
  if (raw == null) return 'unknown'
  const s = String(raw).trim()
  if (!s) return 'unknown'
  if (s.length > 64) throw new CloudSttError('INVALID_CLUSTER')
  return s
}

function segmentId(scope: CloudSttScope, messageSequence: string | number, index: number): string {
  return createHash('sha256')
    .update(JSON.stringify([scope, String(messageSequence), index]))
    .digest('hex')
}

/**
 * Start gate for Listen under a managed profile. Returns ok when cloud STT may proceed,
 * or an honest error (never silently boots Whisper/Parakeet).
 */
export function planCloudSttSession(
  config: CloudSttSessionConfig
):
  | {
      ok: true
      provider: CloudSttProviderId
      cloudOnly: boolean
      modelId?: string
      asrLanguage: string
      novaLanguage: Nova3LanguageQuery
      sonioxLanguage: SonioxLanguageConfig
    }
  | { ok: false; error: string; code: 'CLOUD_ONLY' | 'UNCONFIGURED' } {
  const profile = config.profile ?? resolveEnterpriseLiveProfile({})
  const cloudOnly = isCloudOnlyProfile(profile)
  if (cloudOnly) {
    // Explicitly refuse any accidental local engine selection.
    assertCloudOnlyAllowsEngine(profile, 'parakeet')
  }
  if (config.provider === 'unconfigured') {
    return { ok: false, error: CLOUD_STT_UNCONFIGURED, code: 'UNCONFIGURED' }
  }
  const novaLang = resolveNova3LanguageQuery(config.asrLanguage)
  const sonioxLang = resolveSonioxLanguageConfig(config.asrLanguage)
  return {
    ok: true,
    provider: config.provider,
    cloudOnly,
    asrLanguage: (config.asrLanguage ?? 'auto').trim() || 'auto',
    novaLanguage: novaLang,
    sonioxLanguage: sonioxLang,
    ...(config.provider === 'cloudflare-nova3' ? { modelId: CLOUDFLARE_NOVA3_MODEL } : {})
  }
}

/**
 * When cloud STT fails mid-session, decide whether local fallback is allowed.
 * CLOUD_ONLY → never; legacy → caller may fall back to existing engines.
 */
export function allowLocalSttFallback(
  profile: EnterpriseLiveProfile
): { allowed: true } | { allowed: false; error: string } {
  if (isCloudOnlyProfile(profile)) {
    return { allowed: false, error: CLOUD_ONLY_LOCAL_FALLBACK_BLOCKED }
  }
  return { allowed: true }
}


/**
 * Gateway WebSocket URL builder for Nova-3 via Cloudflare AI Gateway.
 * Credentials are NOT embedded — caller supplies account/gateway ids from trusted config.
 * Returns null when required pieces are missing (honest unconfigured).
 */
export function buildNova3GatewayWsUrl(opts: {
  accountId?: string
  gatewayId?: string
  encoding?: string
  sampleRate?: number
  interimResults?: boolean
  diarize?: boolean
  /**
   * Settings.asrLanguage ('auto' | 'French' | …) or raw BCP-47.
   * Omitted / auto → language=multi + detect_language=true (never silent English default).
   */
  asrLanguage?: string | null
  /** Mid-meeting sticky pin; applied when Settings is auto. */
  pinnedLang?: string | null
  /** Override resolved language tag (tests / advanced). */
  language?: string
  /** Override detect_language flag. */
  detectLanguage?: boolean
}): string | null {
  const accountId = (opts.accountId || '').trim()
  const gatewayId = (opts.gatewayId || '').trim()
  if (!accountId || !gatewayId) return null
  const encoding = opts.encoding || 'linear16'
  const sampleRate = opts.sampleRate ?? 16000
  const interim = opts.interimResults !== false
  const diarize = opts.diarize !== false
  const resolved = resolveNova3LanguageQueryPinned(opts.asrLanguage, opts.pinnedLang)
  const language = (opts.language ?? resolved.language).trim() || 'multi'
  const detectLanguage =
    opts.detectLanguage != null ? opts.detectLanguage : resolved.detect_language
  const q = new URLSearchParams({
    model: CLOUDFLARE_NOVA3_MODEL,
    encoding,
    sample_rate: String(sampleRate),
    interim_results: interim ? 'true' : 'false',
    diarize: diarize ? 'true' : 'false',
    language
  })
  // Always emit detect_language explicitly so callers never inherit Deepgram's en default silently.
  q.set('detect_language', detectLanguage ? 'true' : 'false')
  return `wss://gateway.ai.cloudflare.com/v1/${encodeURIComponent(accountId)}/${encodeURIComponent(gatewayId)}/workers-ai?${q.toString()}`
}

/**
 * Soniox realtime start-config builder (language hints + speaker diarization).
 * Credentials stay out of this payload — caller authenticates the WS separately.
 * enable_speaker_diarization defaults ON so multi-party remote audio is not a single "them" blob.
 * Sticky pin (pinnedLang) applies when Settings.asrLanguage is auto.
 */
export type SonioxStartConfig = {
  language_hints: string[]
  enable_speaker_diarization: boolean
  autoDetect: boolean
}

export function buildSonioxStartConfig(opts: {
  asrLanguage?: string | null
  /** Mid-meeting sticky pin (display name or BCP-47); ignored when Settings is explicit. */
  pinnedLang?: string | null
  enableSpeakerDiarization?: boolean
}): SonioxStartConfig {
  const lang = resolveSonioxLanguageConfigPinned(opts.asrLanguage, opts.pinnedLang)
  return {
    language_hints: lang.language_hints,
    enable_speaker_diarization: opts.enableSpeakerDiarization !== false,
    autoDetect: lang.autoDetect
  }
}

/**
 * Minimal token normalizer — groups consecutive same-cluster finals.
 * Prefer provider-specific normalizers (Soniox / Nova-3) when the wire shape is known.
 */
export function normalizeCloudSttTokens(
  tokens: CloudSttWord[],
  opts: { defaultCluster?: string; scope?: CloudSttScope; messageSequence?: string | number } = {}
): CloudSttNormalizeResult {
  const finals: CloudSttFinalSegment[] = []
  const partial: string[] = []
  let group: { cluster: string; language: string; startMs: number; endMs: number; text: string } | null =
    null
  const flush = (): void => {
    if (!group) return
    if (group.text.trim()) {
      finals.push({
        id: segmentId(opts.scope ?? {}, opts.messageSequence ?? finals.length, finals.length),
        text: group.text,
        startMs: group.startMs,
        endMs: group.endMs,
        cluster: group.cluster,
        language: group.language,
        isFinal: true,
        revision: 1
      })
    }
    group = null
  }
  for (const token of tokens) {
    if (!token.isFinal) {
      partial.push(token.text)
      continue
    }
    const cluster = token.cluster ?? opts.defaultCluster ?? 'unknown'
    const language = token.language ?? 'und'
    if (!group || group.cluster !== cluster || group.language !== language) {
      flush()
      group = { cluster, language, startMs: token.startMs, endMs: token.endMs, text: token.text }
    } else {
      group.text += token.text
      group.startMs = Math.min(group.startMs, token.startMs)
      group.endMs = Math.max(group.endMs, token.endMs)
    }
  }
  flush()
  return { finals, interimText: partial.join(''), finished: false }
}

type SonioxToken = {
  text?: unknown
  is_final?: unknown
  start_ms?: unknown
  end_ms?: unknown
  speaker?: unknown
  language?: unknown
  translation_status?: unknown
}

/**
 * Soniox streaming message normalizer (ported from enterprise-live reference-core).
 * Structured tokens only — not a WebSocket client. Translations never invent timestamps.
 */
export function normalizeSonioxMessage(
  message: { tokens?: unknown; finished?: unknown; error_code?: unknown; error_message?: unknown },
  opts: { scope: CloudSttScope; messageSequence: string | number; streamOffsetMs?: number }
): CloudSttNormalizeResult {
  if (message?.error_code != null) {
    throw new CloudSttError('STT_UPSTREAM_ERROR')
  }
  if (!Array.isArray(message?.tokens) || message.tokens.length > 10_000) {
    throw new CloudSttError('INVALID_STT_MESSAGE')
  }
  const streamOffsetMs = opts.streamOffsetMs ?? 0
  nonNegative(streamOffsetMs, 'INVALID_STREAM_OFFSET')
  const finals: CloudSttFinalSegment[] = []
  const partial: string[] = []
  let group: { cluster: string; language: string; startMs: number; endMs: number; text: string } | null =
    null
  const flush = (): void => {
    if (!group) return
    if (group.text.trim()) {
      finals.push({
        id: segmentId(opts.scope, opts.messageSequence, finals.length),
        text: group.text,
        startMs: group.startMs,
        endMs: group.endMs,
        cluster: group.cluster,
        language: group.language,
        isFinal: true,
        revision: 1
      })
    }
    group = null
  }
  for (const raw of message.tokens as SonioxToken[]) {
    if (!raw || typeof raw.text !== 'string' || typeof raw.is_final !== 'boolean') {
      throw new CloudSttError('INVALID_STT_TOKEN')
    }
    if (raw.translation_status === 'translation') continue
    if (raw.text === '<end>' || raw.text === '<fin>') {
      flush()
      continue
    }
    if (!raw.is_final) {
      partial.push(raw.text)
      continue
    }
    const start = nonNegative(raw.start_ms) + streamOffsetMs
    const end = nonNegative(raw.end_ms) + streamOffsetMs
    if (end < start) throw new CloudSttError('INVALID_STT_TIME')
    const cluster = clusterId(raw.speaker)
    const language = typeof raw.language === 'string' && raw.language ? raw.language : 'und'
    if (!group || group.cluster !== cluster || group.language !== language) {
      flush()
      group = { cluster, language, startMs: start, endMs: end, text: raw.text }
    } else {
      group.text += raw.text
      group.startMs = Math.min(group.startMs, start)
      group.endMs = Math.max(group.endMs, end)
    }
  }
  flush()
  return { finals, interimText: partial.join(''), finished: message.finished === true }
}

type Nova3Word = {
  word?: unknown
  punctuated_word?: unknown
  start?: unknown
  end?: unknown
  speaker?: unknown
  language?: unknown
}

/**
 * Cloudflare Nova-3 / Deepgram `Results` WebSocket message → CloudStt segments.
 * Expects seconds on word start/end (Deepgram wire); converts to ms + optional stream offset.
 * Diarization speaker numbers become clusters — never person names.
 */
export function normalizeNova3ResultsMessage(
  message: {
    type?: unknown
    is_final?: unknown
    speech_final?: unknown
    channel?: { alternatives?: Array<{ transcript?: unknown; words?: Nova3Word[] }> }
  },
  opts: { scope: CloudSttScope; messageSequence: string | number; streamOffsetMs?: number }
): CloudSttNormalizeResult {
  if (message?.type != null && message.type !== 'Results') {
    // Metadata / UtteranceEnd / SpeechStarted — not transcript; empty normalize.
    return { finals: [], interimText: '', finished: false }
  }
  const alt = message?.channel?.alternatives?.[0]
  const words = Array.isArray(alt?.words) ? alt.words : []
  const isFinal = message?.is_final === true || message?.speech_final === true
  const streamOffsetMs = opts.streamOffsetMs ?? 0
  nonNegative(streamOffsetMs, 'INVALID_STREAM_OFFSET')

  if (!words.length) {
    const transcript = typeof alt?.transcript === 'string' ? alt.transcript : ''
    if (!isFinal) {
      return { finals: [], interimText: transcript, finished: false }
    }
    if (!transcript.trim()) {
      return { finals: [], interimText: '', finished: false }
    }
    // Final without word timings — keep text, refuse invented precise attribution.
    throw new CloudSttError('INVALID_STT_TIME')
  }

  const tokens: CloudSttWord[] = []
  for (const w of words) {
    const text =
      typeof w.punctuated_word === 'string' && w.punctuated_word
        ? w.punctuated_word
        : typeof w.word === 'string'
          ? w.word
          : ''
    if (!text) continue
    const startSec = nonNegative(w.start)
    const endSec = nonNegative(w.end)
    if (endSec < startSec) throw new CloudSttError('INVALID_STT_TIME')
    tokens.push({
      text: text.endsWith(' ') ? text : `${text} `,
      startMs: Math.round(startSec * 1000) + streamOffsetMs,
      endMs: Math.round(endSec * 1000) + streamOffsetMs,
      isFinal,
      cluster: clusterId(w.speaker),
      language: typeof w.language === 'string' && w.language ? w.language : 'und'
    })
  }

  if (!isFinal) {
    return {
      finals: [],
      interimText: tokens.map((t) => t.text).join('').trimEnd(),
      finished: false
    }
  }

  const normalized = normalizeCloudSttTokens(tokens, {
    scope: opts.scope,
    messageSequence: opts.messageSequence
  })
  // Trim trailing spaces introduced for word joining.
  for (const f of normalized.finals) {
    f.text = f.text.replace(/\s+/g, ' ').trim()
  }
  return normalized
}

export { resolveCloudSttProvider } from '../../shared/cloud-stt-provider'
export type { CloudSttProviderId } from '../../shared/cloud-stt-provider'
export {
  resolveNova3LanguageQuery,
  resolveNova3LanguageQueryPinned,
  resolveSonioxLanguageConfig,
  resolveSonioxLanguageConfigPinned
} from '../../shared/cloud-stt-language'
export type { Nova3LanguageQuery, SonioxLanguageConfig } from '../../shared/cloud-stt-language'

export { CLOUD_ONLY_LOCAL_FALLBACK_BLOCKED }
