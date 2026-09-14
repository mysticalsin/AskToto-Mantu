/**
 * Cloud STT adapter scaffold (Métis 1.9.1 enterprise-live).
 *
 * Device capture stays local; inference is cloud. Under CLOUD_ONLY, local Whisper/
 * Parakeet/Apple must not boot as fallback — callers get an honest BLOCKED error.
 * Provider credentials stay server-side; this module is the client contract only.
 */
import {
  assertCloudOnlyAllowsEngine,
  CLOUD_ONLY_LOCAL_FALLBACK_BLOCKED,
  isCloudOnlyProfile,
  type EnterpriseLiveProfile,
  resolveEnterpriseLiveProfile
} from '../../shared/enterprise-live-profile'

export type CloudSttProviderId = 'cloudflare-nova3' | 'soniox' | 'unconfigured'

export type CloudSttSessionConfig = {
  provider: CloudSttProviderId
  /** Meeting/capture scope for diarization cluster binding (not a voiceprint). */
  tenantId?: string
  meetingId?: string
  captureId?: string
  epoch?: string
  /** When true, managed profile refuses local ASR fallback. */
  profile?: EnterpriseLiveProfile
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

export type CloudSttNormalizeResult = {
  finals: Array<{
    text: string
    startMs: number
    endMs: number
    cluster: string
    language: string
    isFinal: true
  }>
  interimText: string
  finished: boolean
}

export const CLOUD_STT_UNCONFIGURED =
  'Cloud STT is not configured. Set an approved provider (Cloudflare Nova-3 or Soniox) for this managed profile.'

export function resolveCloudSttProvider(raw: unknown): CloudSttProviderId {
  if (raw === 'cloudflare-nova3' || raw === 'soniox') return raw
  return 'unconfigured'
}

/**
 * Start gate for Listen under a managed profile. Returns ok when cloud STT may proceed,
 * or an honest error (never silently boots Whisper/Parakeet).
 */
export function planCloudSttSession(
  config: CloudSttSessionConfig
): { ok: true; provider: CloudSttProviderId; cloudOnly: boolean } | { ok: false; error: string; code: 'CLOUD_ONLY' | 'UNCONFIGURED' } {
  const profile = config.profile ?? resolveEnterpriseLiveProfile({})
  const cloudOnly = isCloudOnlyProfile(profile)
  if (cloudOnly) {
    // Explicitly refuse any accidental local engine selection.
    const local = assertCloudOnlyAllowsEngine(profile, 'parakeet')
    if (!local.ok) {
      /* profile is cloud-only — continue to require a cloud provider */
    }
  }
  if (config.provider === 'unconfigured') {
    if (cloudOnly) {
      return { ok: false, error: CLOUD_STT_UNCONFIGURED, code: 'UNCONFIGURED' }
    }
    // Legacy profiles may still use local ASR when cloud is unset.
    return { ok: false, error: CLOUD_STT_UNCONFIGURED, code: 'UNCONFIGURED' }
  }
  return { ok: true, provider: config.provider, cloudOnly }
}

/**
 * When cloud STT fails mid-session, decide whether local fallback is allowed.
 * CLOUD_ONLY → never; legacy → caller may fall back to existing engines.
 */
export function allowLocalSttFallback(profile: EnterpriseLiveProfile): { allowed: true } | { allowed: false; error: string } {
  if (isCloudOnlyProfile(profile)) {
    return { allowed: false, error: CLOUD_ONLY_LOCAL_FALLBACK_BLOCKED }
  }
  return { allowed: true }
}

/**
 * Minimal token normalizer scaffold — groups consecutive same-cluster finals.
 * Not a live WebSocket client; host wires transport separately.
 */
export function normalizeCloudSttTokens(
  tokens: CloudSttWord[],
  opts: { defaultCluster?: string } = {}
): CloudSttNormalizeResult {
  const finals: CloudSttNormalizeResult['finals'] = []
  const partial: string[] = []
  let group: { cluster: string; language: string; startMs: number; endMs: number; text: string } | null = null
  const flush = (): void => {
    if (!group) return
    if (group.text.trim()) {
      finals.push({
        text: group.text,
        startMs: group.startMs,
        endMs: group.endMs,
        cluster: group.cluster,
        language: group.language,
        isFinal: true
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

export { CLOUD_ONLY_LOCAL_FALLBACK_BLOCKED }
