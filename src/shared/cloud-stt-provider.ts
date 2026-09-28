/**
 * Cloud STT provider selection (Métis 1.9.1 enterprise-live).
 *
 * Settings.cloudSttProvider is the user/org choice. Under a managed CLOUD_ONLY
 * profile, an unset/unconfigured value resolves to Cloudflare Nova-3 so Speech
 * settings never imply local-first transcription for that profile.
 *
 * Soniox remains selectable for approved benchmark / procurement use. Live
 * WebSocket transport stays in the main cloud-stt adapter; this module is the
 * shared id + defaulting contract only.
 */
import {
  isCloudOnlyProfile,
  type EnterpriseLiveProfile,
  resolveEnterpriseLiveProfile
} from './enterprise-live-profile'
import type { ModelPolicyDocument } from './model-policy'

export const CLOUD_STT_PROVIDERS = ['cloudflare-nova3', 'soniox', 'unconfigured'] as const
export type CloudSttProviderId = (typeof CLOUD_STT_PROVIDERS)[number]

/** Production default for managed cloud-only profiles (skill ref 05 comparator). */
export const DEFAULT_CLOUD_ONLY_STT_PROVIDER: Exclude<CloudSttProviderId, 'unconfigured'> =
  'cloudflare-nova3'

export function resolveCloudSttProvider(raw: unknown): CloudSttProviderId {
  if (raw === 'cloudflare-nova3' || raw === 'soniox') return raw
  return 'unconfigured'
}

/**
 * Effective transcript source for Listen / Settings.
 * CLOUD_ONLY + unconfigured → Cloudflare Nova-3 (honest cloud default).
 * Legacy / unmanaged → stored value (usually unconfigured; on-device asrEngine applies).
 */
export function effectiveCloudSttProvider(
  profile: EnterpriseLiveProfile | unknown,
  stored: unknown
): CloudSttProviderId {
  const p = resolveEnterpriseLiveProfile(profile)
  const id = resolveCloudSttProvider(stored)
  if (id !== 'unconfigured') return id
  if (isCloudOnlyProfile(p)) return DEFAULT_CLOUD_ONLY_STT_PROVIDER
  return 'unconfigured'
}

/**
 * Narrows the cloud speech provider to what the fleet policy's `stt` entry (primary + fallbacks)
 * allows. The user's choice stands when the policy permits it; otherwise the policy's primary provider
 * replaces it, or `unconfigured` when the policy names a provider this app cannot start. `unconfigured`
 * stays `unconfigured` — a policy never turns cloud speech on by itself. Only provider ids are compared:
 * the entry's `model` is not consulted because each speech provider exposes exactly one model; a
 * provider with several selectable models would need the model checked here too. Evaluated once when a session
 * starts, never against a live one.
 */
export function enforceSttPolicy(policy: ModelPolicyDocument | null, provider: CloudSttProviderId): CloudSttProviderId {
  if (!policy || provider === 'unconfigured') return provider
  const entry = policy.capabilities.stt
  if (entry.provider === provider || entry.fallbacks.some((f) => f.provider === provider)) return provider
  return resolveCloudSttProvider(entry.provider)
}

/** True when Listen should use the cloud adapter id instead of Whisper/Parakeet/Apple. */
export function shouldUseCloudSttEngine(
  profile: EnterpriseLiveProfile | unknown,
  storedProvider: unknown
): boolean {
  const p = resolveEnterpriseLiveProfile(profile)
  if (!isCloudOnlyProfile(p)) return false
  return effectiveCloudSttProvider(p, storedProvider) !== 'unconfigured'
}
