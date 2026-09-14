/**
 * Managed enterprise-live profile (Métis 1.9.1 / skill metis-enterprise-live v3).
 *
 * Trusted configuration only: values come from managed-config / validated settings,
 * never from an untrusted renderer boolean alone. Legacy (non-managed) installs keep
 * local ASR + full-transcript saves unchanged.
 */
import { z } from 'zod'

export const ENTERPRISE_LIVE_INFERENCE = ['legacy', 'cloud-only'] as const
export type EnterpriseLiveInference = (typeof ENTERPRISE_LIVE_INFERENCE)[number]

export const EnterpriseLiveProfileSchema = z.object({
  /** Org has enabled the managed cloud-summary profile. */
  managed: z.boolean().default(false),
  /**
   * cloud-only = no Whisper/Parakeet/Apple local STT fallback when the cloud adapter fails.
   * legacy = existing on-device ASR paths remain available.
   */
  inferenceMode: z.enum(ENTERPRISE_LIVE_INFERENCE).default('legacy'),
  /**
   * When true, NEW saveMeeting writes omit the Full transcript section (summary/actions/metadata only).
   * Existing on-disk files are never rewritten or deleted by this flag.
   */
  summaryOnly: z.boolean().default(false)
})
export type EnterpriseLiveProfile = z.infer<typeof EnterpriseLiveProfileSchema>

export const DEFAULT_ENTERPRISE_LIVE_PROFILE: EnterpriseLiveProfile = {
  managed: false,
  inferenceMode: 'legacy',
  summaryOnly: false
}

/** Parse a partial managed-config / settings blob into a validated profile. */
export function resolveEnterpriseLiveProfile(
  raw: unknown
): EnterpriseLiveProfile {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_ENTERPRISE_LIVE_PROFILE }
  const o = raw as Record<string, unknown>
  // Accept either nested `enterpriseLive: {...}` or flat managed-config keys.
  const nested =
    o.enterpriseLive && typeof o.enterpriseLive === 'object'
      ? (o.enterpriseLive as Record<string, unknown>)
      : o
  const parsed = EnterpriseLiveProfileSchema.safeParse({
    managed: nested.managed ?? nested.enterpriseLiveManaged,
    inferenceMode: nested.inferenceMode ?? nested.enterpriseLiveInferenceMode,
    summaryOnly: nested.summaryOnly ?? nested.enterpriseLiveSummaryOnly
  })
  return parsed.success ? parsed.data : { ...DEFAULT_ENTERPRISE_LIVE_PROFILE }
}

/** CLOUD_ONLY gate: managed profile with inferenceMode cloud-only. */
export function isCloudOnlyProfile(profile: EnterpriseLiveProfile): boolean {
  return profile.managed === true && profile.inferenceMode === 'cloud-only'
}

/** SUMMARY_ONLY gate: managed profile that must not persist fresh full transcripts. */
export function isSummaryOnlyProfile(profile: EnterpriseLiveProfile): boolean {
  return profile.managed === true && profile.summaryOnly === true
}

/**
 * Local ASR engines that must not boot / must not be used as fallback under CLOUD_ONLY.
 * 'cloud' is the managed adapter id (not a Settings asrEngine enum value today).
 */
export const LOCAL_ASR_ENGINES = ['whisper', 'parakeet', 'apple'] as const
export type LocalAsrEngine = (typeof LOCAL_ASR_ENGINES)[number]

export function isLocalAsrEngine(engine: string | undefined | null): engine is LocalAsrEngine {
  return !!engine && (LOCAL_ASR_ENGINES as readonly string[]).includes(engine)
}

/**
 * Honest refusal when a managed cloud-only profile would otherwise fall back to local STT.
 * Callers surface this to the UI / FITO path — never silently switch engines.
 */
export const CLOUD_ONLY_LOCAL_FALLBACK_BLOCKED =
  'CLOUD_ONLY: local speech recognition is disabled for this managed enterprise profile. Configure an approved cloud STT adapter or turn off cloud-only inference.'

export function assertCloudOnlyAllowsEngine(
  profile: EnterpriseLiveProfile,
  engine: string | undefined | null
): { ok: true } | { ok: false; error: string } {
  if (!isCloudOnlyProfile(profile)) return { ok: true }
  if (isLocalAsrEngine(engine)) {
    return { ok: false, error: CLOUD_ONLY_LOCAL_FALLBACK_BLOCKED }
  }
  return { ok: true }
}
