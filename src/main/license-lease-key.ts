/**
 * license-lease-key.ts — bundles the license server Ed25519 LEASE PUBLIC KEY.
 * Packaged builds refuse the DEV fallback; check:release fails closed without production pubkey.json.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isPackagedBuild } from './dev-env'
import { mainLog } from './logger'

export const LICENSE_LEASE_ALGORITHM = 'ed25519'

const DEV_LEASE_PUBLIC_KEY = 'FzzE8mBXkx36otsurVczzedp9q1_KqGZHYtHbnZOuTY'


function provisionedPubkeyPath(): string {
  return join(process.resourcesPath, 'license-lease', 'pubkey.json')
}

function readProvisionedPubkey(): string | null {
  try {
    const path = provisionedPubkeyPath()
    if (!existsSync(path)) return null
    const data = JSON.parse(readFileSync(path, 'utf8')) as { publicKey?: unknown }
    return typeof data.publicKey === 'string' && data.publicKey ? data.publicKey : null
  } catch (e) {
    mainLog.warn('[license-lease-key] could not read the provisioned lease public key', e)
    return null
  }
}

export function embeddedLicenseLeasePubkeyAvailable(): boolean {
  const key = readProvisionedPubkey()
  return key !== null && key !== DEV_LEASE_PUBLIC_KEY
}

export function getLicenseLeasePublicKeyRaw(): string {
  const provisioned = readProvisionedPubkey()
  if (isPackagedBuild()) {
    if (!provisioned || provisioned === DEV_LEASE_PUBLIC_KEY) {
      throw new Error(
        'Packaged build is missing a production license-lease public key ' +
          '(resources/license-lease/pubkey.json). Refusing the DEV fallback.'
      )
    }
    return provisioned
  }
  return provisioned ?? DEV_LEASE_PUBLIC_KEY
}

export function devLeasePublicKeyForTests(): string {
  return DEV_LEASE_PUBLIC_KEY
}
