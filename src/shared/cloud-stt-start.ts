import { effectiveCloudSttProvider, enforceSttPolicy, type CloudSttProviderId } from './cloud-stt-provider'
import type { SttResolvedIdentity } from './contracts/stt-provider'

export type CloudSttStartResult =
  | { ok: true; provider: 'cloudflare-nova3' | 'soniox'; resolvedIdentity?: SttResolvedIdentity }
  | { ok: false; error?: string; code?: string }

/** A renderer's requested provider never supplies evidence of the actual main-owned connection. */
export function cloudSttStartAcknowledgement(
  result: { ok: boolean; error?: string; code?: string; identity?: SttResolvedIdentity },
  provider: unknown
): CloudSttStartResult {
  if (!result.ok) return result as Extract<CloudSttStartResult, { ok: false }>
  // The identity main resolved must name the same provider main acknowledges; one request, one identity.
  if (
    (provider !== 'cloudflare-nova3' && provider !== 'soniox') ||
    (result.identity && result.identity.provider !== provider)
  ) {
    return { ok: false, error: 'Cloud speech provider was not acknowledged.', code: 'INVALID_PROVIDER' }
  }
  return result.identity ? { ok: true, provider, resolvedIdentity: result.identity } : { ok: true, provider }
}
export function resolveCloudSttStartProvider(
  policy: Parameters<typeof enforceSttPolicy>[0],
  profile: unknown,
  storedProvider: unknown
): CloudSttProviderId {
  return enforceSttPolicy(policy, effectiveCloudSttProvider(profile, storedProvider))
}
