/**
 * Resolve Nova-3 / Soniox live-WS credentials from existing Operator/gateway patterns.
 * Secrets stay main-side (keystore / env). Never log token values.
 *
 * Gateway id follows Operator `ensureDefaultAiGateway`: when Settings / env leave the gateway
 * blank, resolve to `default` so a seated CF account token + accountId is enough (no bare
 * METIS_CF_AI_GATEWAY_ID required).
 */
import type { CloudSttProviderId } from '../../shared/cloud-stt-provider'
import { CLOUD_STT_UNCONFIGURED } from './adapter'

/** Same id Operator POSTs in ensureDefaultAiGateway / Ask cf-aig-gateway-id header. */
export const DEFAULT_CLOUD_STT_GATEWAY_ID = 'default'

export const CLOUD_STT_CREDENTIALS_MISSING =
  'Cloud STT credentials are missing. For Nova-3, seat a Cloudflare account API token in Settings (Keys / AI), set an account id or an account-scoped base URL (.../accounts/<id>/ai/v1), and optionally a CF AI Gateway id (blank uses default). Env CF_AI_GATEWAY_ID / METIS_CF_AI_GATEWAY_ID also work. For Soniox, seat a key in Settings → Speech or set SONIOX_API_KEY (optional). Managed CLOUD_ONLY does not fall back to on-device speech.'

export type CloudSttResolvedCreds =
  | {
      ok: true
      provider: 'cloudflare-nova3'
      token: string
      accountId: string
      gatewayId: string
    }
  | {
      ok: true
      provider: 'soniox'
      apiKey: string
      wsUrl: string
    }
  | { ok: false; error: string; code: 'UNCONFIGURED' | 'CREDENTIALS' }

const ACCOUNT_RE = /\/accounts\/([a-f0-9]{32})\b/i
const ACCOUNT_ID_RE = /^[a-f0-9]{32}$/i
export const SONIOX_DEFAULT_WS_URL = 'wss://stt-rt.soniox.com/transcribe-websocket'

/** Extract Cloudflare account id from an account-scoped Workers AI base URL. */
export function parseCloudflareAccountId(baseUrl: string | null | undefined): string | null {
  const raw = (baseUrl || '').trim()
  if (!raw) return null
  const m = ACCOUNT_RE.exec(raw)
  return m?.[1]?.toLowerCase() ?? null
}

/**
 * Prefer account id from an account-scoped base URL; otherwise accept a seated 32-hex account id
 * (Operator / Portal Keys paste shape) when the default Worker proxy URL has no /accounts/ path.
 */
export function resolveCloudflareAccountId(input: {
  cloudflareBaseUrl?: string | null
  cloudflareAccountId?: string | null
}): string | null {
  const fromUrl = parseCloudflareAccountId(input.cloudflareBaseUrl)
  if (fromUrl) return fromUrl
  const raw = (input.cloudflareAccountId || '').trim().toLowerCase()
  if (ACCOUNT_ID_RE.test(raw)) return raw
  return null
}

/**
 * Settings.cfAiGatewayId first, then env, then Operator-style `default`.
 * Never returns null — blank seats resolve to DEFAULT_CLOUD_STT_GATEWAY_ID.
 */
export function resolveCloudSttGatewayId(
  seated?: string | null,
  env: NodeJS.ProcessEnv = process.env
): string {
  const fromSettings = (seated || '').trim()
  if (fromSettings) return fromSettings
  const a = (env.CF_AI_GATEWAY_ID || '').trim()
  if (a) return a
  const b = (env.METIS_CF_AI_GATEWAY_ID || '').trim()
  if (b) return b
  return DEFAULT_CLOUD_STT_GATEWAY_ID
}

export function resolveSonioxApiKey(
  seated?: string | null,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const fromSeat = (seated || '').trim()
  if (fromSeat) return fromSeat
  const k = (env.SONIOX_API_KEY || '').trim()
  return k || null
}

export function resolveCloudSttCredentials(input: {
  provider: CloudSttProviderId
  cloudflareToken?: string | null
  cloudflareBaseUrl?: string | null
  cloudflareAccountId?: string | null
  gatewayId?: string | null
  sonioxApiKey?: string | null
  sonioxWsUrl?: string | null
}): CloudSttResolvedCreds {
  if (input.provider === 'unconfigured') {
    return { ok: false, error: CLOUD_STT_UNCONFIGURED, code: 'UNCONFIGURED' }
  }
  if (input.provider === 'soniox') {
    const apiKey = (input.sonioxApiKey || '').trim()
    if (!apiKey) {
      return { ok: false, error: CLOUD_STT_CREDENTIALS_MISSING, code: 'CREDENTIALS' }
    }
    const wsUrl = (input.sonioxWsUrl || '').trim() || SONIOX_DEFAULT_WS_URL
    return { ok: true, provider: 'soniox', apiKey, wsUrl }
  }
  // cloudflare-nova3
  const token = (input.cloudflareToken || '').trim()
  const accountId = resolveCloudflareAccountId({
    cloudflareBaseUrl: input.cloudflareBaseUrl,
    cloudflareAccountId: input.cloudflareAccountId
  })
  // Blank gateway → default (same as resolveCloudSttGatewayId); callers usually pass the resolved id.
  const gatewayId = (input.gatewayId || '').trim() || DEFAULT_CLOUD_STT_GATEWAY_ID
  if (!token || !accountId || !gatewayId) {
    return { ok: false, error: CLOUD_STT_CREDENTIALS_MISSING, code: 'CREDENTIALS' }
  }
  return { ok: true, provider: 'cloudflare-nova3', token, accountId, gatewayId }
}
