import type { MemberLicenseStatus } from '@shared/license-types'
import { emptyLicenseStatus } from '@shared/license-types'
import { operatorLicenseLast4 } from '@shared/operator-license'
import { getSettings } from '../store'
import { verifyOperatorLicenseSync } from './operator-token'
import { readOperatorLicenseCache } from './secret-store'

function ingestSecret(): string {
  try {
    return (getSettings().operatorIngestSecret || process.env.METIS_OPERATOR_INGEST_SECRET || '').trim()
  } catch {
    return (process.env.METIS_OPERATOR_INGEST_SECRET || '').trim()
  }
}

export function operatorLicenseStatus(now = Date.now()): MemberLicenseStatus | null {
  const cache = readOperatorLicenseCache()
  if (!cache) return null
  const secret = ingestSecret()
  const verified = verifyOperatorLicenseSync(secret, cache.token, now)
  if (!verified.ok && verified.error === 'expired') {
    return emptyLicenseStatus({
      state: 'expired',
      edition: 'pro',
      seats: 1,
      expiresAt: cache.exp * 1000,
      orgId: 'operator',
      source: 'operator',
      error: 'expired'
    })
  }
  if (!verified.ok) {
    return emptyLicenseStatus({
      source: 'operator',
      error: verified.error === 'invalid' ? 'tampered' : verified.error
    })
  }
  return emptyLicenseStatus({
    state: 'licensed',
    edition: 'pro',
    seats: 1,
    expiresAt: verified.claims.exp * 1000,
    features: ['operator-keys'],
    orgId: 'operator',
    source: 'operator'
  })
}

export function identityLicenseMeta(
  now = Date.now()
): { license: string; licenseLast4?: string; licenseId?: string } | null {
  const cache = readOperatorLicenseCache()
  if (!cache) return null
  const status = operatorLicenseStatus(now)
  if (!status) return null
  const last4 = cache.last4 || operatorLicenseLast4(cache.token)
  if (status.state === 'licensed' || status.state === 'grace') {
    return { license: 'licensed', licenseLast4: last4, licenseId: cache.jti }
  }
  if (status.state === 'expired') {
    return { license: 'expired', licenseLast4: last4, licenseId: cache.jti }
  }
  return null
}
