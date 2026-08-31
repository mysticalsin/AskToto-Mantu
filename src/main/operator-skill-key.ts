/**
 * Bundled Ed25519 PUBLIC key for Operator skill packs. Same rule as license-lease-key.ts:
 * a public key is safe to commit. The matching private key is a Wrangler secret
 * (OPERATOR_SKILL_PRIVATE_KEY) and is never in this repo.
 *
 * Dev placeholder lets CI verify the apply path. Production builds should replace
 * resources/operator/pubkey.json with the live public half.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const OPERATOR_SKILL_ALGORITHM = 'ed25519'

/** Dev/test public key (JWK x). Matching private key lives only in operator/src/test-fixtures.ts. */
const DEV_OPERATOR_PUBLIC_KEY = 'ahLO-YDwg2Z9RipORWu0kdUO4Ehw81FdwwUsfbN7DqI'

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

export function getOperatorSkillPublicKeyRaw(): string {
  return readProvisioned() ?? DEV_OPERATOR_PUBLIC_KEY
}

export function devOperatorPublicKeyForTests(): string {
  return DEV_OPERATOR_PUBLIC_KEY
}
