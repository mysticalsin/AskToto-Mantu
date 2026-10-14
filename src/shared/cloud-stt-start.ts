export type CloudSttStartResult =
  | { ok: true; provider: 'cloudflare-nova3' | 'soniox' }
  | { ok: false; error?: string; code?: string }

/** A renderer's requested provider never supplies evidence of the actual main-owned connection. */
export function cloudSttStartAcknowledgement(
  result: { ok: boolean; error?: string; code?: string },
  provider: unknown
): CloudSttStartResult {
  if (!result.ok) return result as Extract<CloudSttStartResult, { ok: false }>
  if (provider !== 'cloudflare-nova3' && provider !== 'soniox') {
    return { ok: false, error: 'Cloud speech provider was not acknowledged.', code: 'INVALID_PROVIDER' }
  }
  return { ok: true, provider }
}
import { effectiveCloudSttProvider, enforceSttPolicy, type CloudSttProviderId } from './cloud-stt-provider'

export function resolveCloudSttStartProvider(
  policy: Parameters<typeof enforceSttPolicy>[0],
  profile: unknown,
  storedProvider: unknown
): CloudSttProviderId {
  return enforceSttPolicy(policy, effectiveCloudSttProvider(profile, storedProvider))
}
