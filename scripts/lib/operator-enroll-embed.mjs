// operator-enroll-embed.mjs — the build-time helpers shared by the Operator enrolment token embed step
// (scripts/embed-operator-enroll-token.mjs), its packaging gate (scripts/check-embedded-operator-enroll.mjs)
// and the release secret gate (scripts/check-release-secrets.mjs). The runtime reader is
// src/main/embedded-operator-enroll.ts; it must accept exactly what this module produces.
//
// The blob reuses scripts/lib/embedded-cloudflare-crypto.mjs. It is OBFUSCATED, not secret: the passphrase
// ships in the app. What makes the token safe to ship is its scope on the Worker (enrolment only, `reporting`
// tier, capped, revocable), never the encryption.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Same shape the runtime reader accepts (src/main/embedded-operator-enroll.ts). */
export const ENROLL_TOKEN_RE = /^METIS-ENR-1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

/** Path of the packaged blob relative to a resources directory, in forward-slash form for messages. */
export const PACKAGED_BLOB = 'operator-embed/enroll.json'

/** DEFAULT_OPERATOR_URL, read from the one place it is defined so the two can never drift. */
export function defaultOperatorUrl() {
  const source = readFileSync(join(REPO_ROOT, 'src', 'shared', 'operator.ts'), 'utf8')
  const match = /export const DEFAULT_OPERATOR_URL\s*=\s*'(https:\/\/[^']+)'/.exec(source)
  if (!match) throw new Error('could not read DEFAULT_OPERATOR_URL from src/shared/operator.ts')
  return match[1]
}

/** Strip whitespace and trailing slashes; the runtime compares against the slash-less base URL. */
export function normalizeOperatorUrl(url) {
  return String(url ?? '')
    .trim()
    .replace(/\/+$/, '')
}

/** True when METIS_OPERATOR_ENROLL_REQUIRED opts the build into failing closed on a missing token. */
export function enrollRequired(env) {
  return String(env.METIS_OPERATOR_ENROLL_REQUIRED ?? '').trim() === '1'
}

/**
 * Parse the decrypted plaintext. Returns {token, operatorUrl} or null. Never throws, never echoes the token.
 */
export function parseEnrollPayload(plaintext) {
  let obj
  try {
    obj = JSON.parse(String(plaintext ?? ''))
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const token = typeof obj.token === 'string' ? obj.token.trim() : ''
  const operatorUrl = normalizeOperatorUrl(obj.operatorUrl)
  if (!ENROLL_TOKEN_RE.test(token) || !/^https:\/\//i.test(operatorUrl)) return null
  return { token, operatorUrl }
}
