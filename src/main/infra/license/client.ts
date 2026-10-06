/**
 * LicenseClient: the real interface. The closed stub is an implementation of
 * this interface, not a comment. When LICENSE_ACTIVATION_OPEN flips, the
 * network implementation is selected without changing activate() callers.
 */
import {
  LICENSE_ACTIVATION_OPEN,
  V1ActivateResponseSchema,
  V1RegisterResponseSchema,
  type V1ActivateRequest,
  type V1ActivateResponse,
  type V1RegisterRequest,
  type V1RegisterResponse
} from '@shared/license-types'
import { isSecureLicenseServerUrl, normalizeLicenseServerUrl } from './server-url'

const ACTIVATE_TIMEOUT_MS = 10_000

export interface LicenseClient {
  activate(req: V1ActivateRequest): Promise<V1ActivateResponse>
  registerInstall(req: V1RegisterRequest): Promise<V1RegisterResponse>
}

export const unavailableLicenseClient: LicenseClient = {
  async activate(): Promise<V1ActivateResponse> {
    return { ok: false, error: 'activation_unavailable' }
  },
  async registerInstall(): Promise<V1RegisterResponse> {
    return { ok: false, error: 'activation_unavailable' }
  }
}

export function createNetworkLicenseClient(serverUrl: string): LicenseClient {
  const base = normalizeLicenseServerUrl(serverUrl)
  const secure = isSecureLicenseServerUrl(base)
  return {
    async activate(req: V1ActivateRequest): Promise<V1ActivateResponse> {
      if (!secure) return { ok: false, error: 'network' }
      try {
        const res = await fetch(`${base}/v1/licenses/activate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req),
          redirect: 'error',
          signal: AbortSignal.timeout(ACTIVATE_TIMEOUT_MS)
        })
        const parsed = V1ActivateResponseSchema.safeParse(await res.json())
        if (!parsed.success) return { ok: false, error: 'network' }
        return parsed.data
      } catch {
        return { ok: false, error: 'network' }
      }
    },
    async registerInstall(req: V1RegisterRequest): Promise<V1RegisterResponse> {
      if (!secure) return { ok: false, error: 'network' }
      try {
        const res = await fetch(`${base}/v1/installs/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req),
          redirect: 'error',
          signal: AbortSignal.timeout(ACTIVATE_TIMEOUT_MS)
        })
        const parsed = V1RegisterResponseSchema.safeParse(await res.json())
        if (!parsed.success) return { ok: false, error: 'network' }
        return parsed.data
      } catch {
        return { ok: false, error: 'network' }
      }
    }
  }
}

export function getLicenseClient(serverUrl?: string): LicenseClient {
  if (!LICENSE_ACTIVATION_OPEN) return unavailableLicenseClient
  if (!serverUrl?.trim()) return unavailableLicenseClient
  return createNetworkLicenseClient(serverUrl)
}
