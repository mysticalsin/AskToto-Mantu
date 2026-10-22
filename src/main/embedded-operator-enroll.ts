/**
 * Runtime reader for the build-embedded Operator enrolment token (seam from O07, filled by O11).
 *
 * The packaged blob is produced at build time (scripts/embed-operator-enroll-token.mjs) and holds
 * `{ token, operatorUrl }`, AES-256-GCM encrypted with the same material as the Cloudflare embed. It is
 * obfuscated, not secret: the token is scoped to enrolment, `reporting` tier only, capped and revocable on
 * the Worker. This module is the single seam the enrolment glue reads. Until a build ships a blob (every
 * dev, QA-without-token and local build) it returns null, and enrolment falls back to the SSO path only,
 * which is the designed missing-token behaviour.
 *
 * `primeEmbeddedOperatorEnroll` reads and decrypts the blob once, asynchronously (no sync fs in main), and
 * installs the provider. The token is used only when the Operator base URL equals the blob's `operatorUrl`;
 * that anti-redirect rule lives in operator-enrollment.ts (embeddedFor), the same rule as the env credential.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decryptEmbeddedBlob, type EncryptedCloudflareKeyBlob } from './embedded-cloudflare-crypto'

export interface EmbeddedOperatorEnrollToken {
  /** `METIS-ENR-1.<kid>.<secret>` */
  token: string
  /** The Operator URL this token was issued for. The caller uses the token only when it equals the base URL. */
  operatorUrl: string
}

const TOKEN_RE = /^METIS-ENR-1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

type Provider = () => EmbeddedOperatorEnrollToken | null
// primeEmbeddedOperatorEnroll installs the decrypting provider here; no provider means no embedded token.
let provider: Provider | null = null

export function setEmbeddedOperatorEnrollProvider(next: Provider | null): void {
  provider = next
}

/** Validate a decrypted `{token, operatorUrl}` payload. Null for anything unusable. Never throws. */
function parsePayload(plaintext: string | null): EmbeddedOperatorEnrollToken | null {
  if (!plaintext) return null
  try {
    const obj = JSON.parse(plaintext) as { token?: unknown; operatorUrl?: unknown }
    const token = typeof obj.token === 'string' ? obj.token.trim() : ''
    const operatorUrl = typeof obj.operatorUrl === 'string' ? obj.operatorUrl.trim().replace(/\/+$/, '') : ''
    if (!TOKEN_RE.test(token) || !/^https:\/\//i.test(operatorUrl)) return null
    return { token, operatorUrl }
  } catch {
    return null
  }
}

/** Absolute path of the packaged encrypted blob (ciphertext only). Null outside a packaged Electron app. */
function packagedBlobPath(): string | null {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  return typeof resources === 'string' && resources ? join(resources, 'operator-embed', 'enroll.json') : null
}

/**
 * Read and decrypt the packaged blob once and serve it through the provider. Never rejects and never logs the
 * plaintext: a missing, corrupt, tampered or malformed blob leaves the provider returning null (SSO only).
 */
export async function primeEmbeddedOperatorEnroll(blobPath: string | null = packagedBlobPath()): Promise<void> {
  let value: EmbeddedOperatorEnrollToken | null = null
  try {
    if (blobPath) {
      const blob = JSON.parse(await readFile(blobPath, 'utf8')) as EncryptedCloudflareKeyBlob
      value = parsePayload(decryptEmbeddedBlob(blob))
    }
  } catch {
    value = null
  }
  setEmbeddedOperatorEnrollProvider(value ? () => value : null)
}

export function readEmbeddedOperatorEnrollToken(): EmbeddedOperatorEnrollToken | null {
  let value: EmbeddedOperatorEnrollToken | null = null
  try {
    value = provider?.() ?? null
  } catch {
    return null
  }
  if (!value || !TOKEN_RE.test(value.token) || !/^https:\/\//i.test(value.operatorUrl)) return null
  return value
}
