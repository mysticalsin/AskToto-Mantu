/**
 * Resolve Nova-3 / Soniox live-WS credentials from existing Operator/gateway patterns.
 * Secrets stay main-side (keystore / env). Never log token values.
 */
import type { CloudSttProviderId } from '../../shared/cloud-stt-provider'
import { CLOUD_STT_UNCONFIGURED } from './adapter'

export const CLOUD_STT_CREDENTIALS_MISSING =
  'Cloud STT credentials are missing. For Nova-3, set a Cloudflare account API token and an account-scoped base URL (…/accounts/<id>/ai/v1), plus CF_AI_GATEWAY_ID (or METIS_CF_AI_GATEWAY_ID). For Soniox, set SONIOX_API_KEY. Managed CLOUD_ONLY does not fall back to on-device speech.'

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
export const SONIOX_DEFAULT_WS_URL = 'wss://stt-rt.soniox.com/transcribe-websocket'

/** Extract Cloudflare account id from an account-scoped Workers AI base URL. */
export function parseCloudflareAccountId(baseUrl: string | null | undefined): string | null {
  const raw = (baseUrl || '').trim()
  if (!raw) return null
  const m = ACCOUNT_RE.exec(raw)
  return m?.[1]?.toLowerCase() ?? null
}

export function resolveCloudSttGatewayId(env: NodeJS.ProcessEnv = process.env): string | null {
  const a = (env.CF_AI_GATEWAY_ID || '').trim()
  if (a) return a
  const b = (env.METIS_CF_AI_GATEWAY_ID || '').trim()
  return b || null
}

export function resolveSonioxApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const k = (env.SONIOX_API_KEY || '').trim()
  return k || null
}

export function resolveCloudSttCredentials(input: {
  provider: CloudSttProviderId
  cloudflareToken?: string | null
  cloudflareBaseUrl?: string | null
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
  const accountId = parseCloudflareAccountId(input.cloudflareBaseUrl)
  const gatewayId = (input.gatewayId || '').trim()
  if (!token || !accountId || !gatewayId) {
    return { ok: false, error: CLOUD_STT_CREDENTIALS_MISSING, code: 'CREDENTIALS' }
  }
  return { ok: true, provider: 'cloudflare-nova3', token, accountId, gatewayId }
}
