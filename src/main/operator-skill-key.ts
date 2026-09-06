/**
 * Bundled Ed25519 PUBLIC key for Operator skill packs. Same rule as license-lease-key.ts:
 * a public key is safe to commit. The matching private key is a Wrangler secret
 * (OPERATOR_SKILL_PRIVATE_KEY) and is never in this repo.
 *
 * Dev placeholder is a public half only. The matching private key is not in this
 * repo. Tests mint a fresh pair with generateKeyPairSync. Production builds
 * MUST provision resources/operator/pubkey.json (see that directory's README) and
 * ship it via electron-builder extraResources. Packaged builds refuse the DEV
 * fallback — check:release fails closed if the production public half is missing
 * or still equals the DEV placeholder.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isPackagedBuild } from './dev-env'

export const OPERATOR_SKILL_ALGORITHM = 'ed25519'

/** Dev public key (JWK x). No matching private key is committed. */
const DEV_OPERATOR_PUBLIC_KEY = '0782eTCPPOCzxP6yQ_LT8qcXS_t7vE-eDh_DpLf0cV0'

function provisionedPath(): string {
  return join(process.resourcesPath, 'operator', 'pubkey.json')
}

function readProvisioned(): string | null {
  try {
    const p = provisionedPath()
    if (!existsSync(p)) return null
    const data = JSON.parse(readFileSync(p, 'utf8')) as { publicKey?: unknown }
    return typeof data.publicKey === 'string' && data.publicKey ? data.publicKey : null
  } catch {
    return null
  }
}

/** True only when a REAL, build-provisioned key is present (not the DEV placeholder). */
export function embeddedOperatorSkillPubkeyAvailable(): boolean {
  const key = readProvisioned()
  return key !== null && key !== DEV_OPERATOR_PUBLIC_KEY
}

/**
 * The raw base64url Ed25519 public key to verify Operator skill packs against.
 * Packaged builds never fall back to the DEV key — missing or DEV-equal provisioned
 * material throws so a ship cannot silently pin the repository placeholder.
 */
export function getOperatorSkillPublicKeyRaw(): string {
  const provisioned = readProvisioned()
  if (isPackagedBuild()) {
    if (!provisioned || provisioned === DEV_OPERATOR_PUBLIC_KEY) {
      throw new Error(
        'Packaged build is missing a production Operator skill public key ' +
          '(resources/operator/pubkey.json). Refusing the DEV fallback.'
      )
    }
    return provisioned
  }
  return provisioned ?? DEV_OPERATOR_PUBLIC_KEY
}

export function devOperatorPublicKeyForTests(): string {
  return DEV_OPERATOR_PUBLIC_KEY
}
