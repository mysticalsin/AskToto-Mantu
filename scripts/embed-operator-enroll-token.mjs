#!/usr/bin/env node
/**
 * embed-operator-enroll-token.mjs — build step that turns the Operator enrolment token into the ENCRYPTED
 * blob electron-builder packages (src/main/embedded-operator-enroll.ts reads it at runtime). Same pattern as
 * scripts/embed-cloudflare-key.mjs, and it reuses scripts/lib/embedded-cloudflare-crypto.mjs.
 *
 * Reads the token ONLY from the environment, never from a file or from source:
 *   - METIS_OPERATOR_ENROLL_TOKEN        `METIS-ENR-1.<kid>.<secret>`
 *   - METIS_OPERATOR_ENROLL_URL          optional; defaults to DEFAULT_OPERATOR_URL (src/shared/operator.ts)
 *   - with `--qa`, METIS_OPERATOR_ENROLL_TOKEN_QA and METIS_OPERATOR_ENROLL_URL_QA instead (the QA lane's
 *     staging-channel token, bound to the staging URL).
 *
 * With no token the step does nothing and says so: a build without a token enrols through SSO only, which is
 * the designed fallback. It also deletes any blob left by an earlier tokened build, so a later local build can
 * never ship a stale token.
 *
 * The plaintext token is never written to disk, only the AES-256-GCM ciphertext to
 * build/operator-embed/enroll.json. The blob is obfuscation, not secrecy; the token's scope on the Worker
 * (enrolment only, `reporting` tier, capped, revocable) is what makes it safe to ship.
 *
 * Usage: node scripts/embed-operator-enroll-token.mjs [--qa]
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decryptProxyKey, encryptProxyKey } from './lib/embedded-cloudflare-crypto.mjs'
import {
  ENROLL_TOKEN_RE,
  defaultOperatorUrl,
  normalizeOperatorUrl,
  parseEnrollPayload
} from './lib/operator-enroll-embed.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_OUT_DIR = join(repoRoot, 'build', 'operator-embed')

/**
 * @param {{ env?: Record<string, string | undefined>, outDir?: string, qa?: boolean, log?: (m: string) => void }} [options]
 * @returns {{ wrote: boolean }}
 */
export function embedOperatorEnrollToken(options = {}) {
  const env = options.env ?? process.env
  const outDir = options.outDir ?? DEFAULT_OUT_DIR
  const log = options.log ?? ((m) => console.log(m))
  const qa = options.qa === true
  const tokenVar = qa ? 'METIS_OPERATOR_ENROLL_TOKEN_QA' : 'METIS_OPERATOR_ENROLL_TOKEN'
  const urlVar = qa ? 'METIS_OPERATOR_ENROLL_URL_QA' : 'METIS_OPERATOR_ENROLL_URL'
  const outFile = join(outDir, 'enroll.json')

  const token = String(env[tokenVar] ?? '').trim()
  if (!token) {
    rmSync(outFile, { force: true })
    log(
      `[embed:operator-enroll] ${tokenVar} is not set - skipping the embedded enrolment token. ` +
        'This build enrols through SSO only.'
    )
    return { wrote: false }
  }
  if (!ENROLL_TOKEN_RE.test(token)) {
    throw new Error(
      `[embed:operator-enroll] ${tokenVar} is not a METIS-ENR-1.<kid>.<secret> token; refusing to embed it`
    )
  }
  const operatorUrl = normalizeOperatorUrl(env[urlVar]) || defaultOperatorUrl()
  if (!/^https:\/\//i.test(operatorUrl)) {
    throw new Error(`[embed:operator-enroll] ${urlVar} must be an https:// URL`)
  }

  const payload = JSON.stringify({ token, operatorUrl })
  const blob = encryptProxyKey(payload)
  // Prove the round trip on the real parameters, so a blob the runtime cannot read never ships.
  const back = parseEnrollPayload(decryptProxyKey(blob))
  if (!back || back.token !== token || back.operatorUrl !== operatorUrl) {
    throw new Error(
      '[embed:operator-enroll] internal error: the blob did not decrypt back to the payload; refusing to write it'
    )
  }
  const serialized = JSON.stringify(blob, null, 2)
  if (serialized.includes(token)) {
    throw new Error(
      '[embed:operator-enroll] internal error: the serialized blob contains the plaintext token; refusing to write it'
    )
  }

  mkdirSync(outDir, { recursive: true })
  writeFileSync(outFile, `${serialized}\n`, { mode: 0o600 })
  log(
    `[embed:operator-enroll] wrote the encrypted enrolment blob to ${outFile} (ciphertext only, bound to ${operatorUrl}).`
  )
  log('[embed:operator-enroll] The blob is OBFUSCATED, not secret. Its safety is the token scope on the Worker.')
  return { wrote: true }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  embedOperatorEnrollToken({
    qa: process.argv.includes('--qa'),
    // Test seam only; a real build always writes to build/operator-embed.
    outDir: process.env.METIS_OPERATOR_EMBED_OUT_DIR?.trim() || DEFAULT_OUT_DIR
  })
}
