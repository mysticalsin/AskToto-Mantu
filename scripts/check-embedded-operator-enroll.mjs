#!/usr/bin/env node
/**
 * check-embedded-operator-enroll.mjs <output-directory> — packaging gate for the build-embedded Operator
 * enrolment token (scripts/embed-operator-enroll-token.mjs, src/main/embedded-operator-enroll.ts).
 *
 * With a staged blob (build/operator-embed/enroll.json) the packaged copy must exist, decrypt with the shared
 * material, hold a `METIS-ENR-1.` token and an https URL, and the plaintext token must appear nowhere in the
 * packaged resources. A staged blob the package does not carry, or a packaged blob that was never staged
 * (a stale output directory), fails.
 *
 * With no blob the build enrols through SSO only. That passes with a warning, unless
 * METIS_OPERATOR_ENROLL_REQUIRED=1, which fails closed.
 *
 * The blob is obfuscation, not secrecy. This gate never prints the token.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decryptProxyKey, isEncryptedBlob } from './lib/embedded-cloudflare-crypto.mjs'
import { PACKAGED_BLOB, enrollRequired, parseEnrollPayload } from './lib/operator-enroll-embed.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const LOCAL_BLOB = join(repoRoot, 'build', 'operator-embed', 'enroll.json')

// Large fetched asset trees can never hold the token and would turn the scan into a multi-GB read.
const SKIP_DIRS = new Set(['models', 'asr', 'ort', 'llama', 'ffmpeg', 'mac-helper', 'local-llm', 'local-ai'])
const MAX_SCAN_BYTES = 512 * 1024 * 1024

function findResourcesDir(root) {
  const candidates = [
    join(root, 'win-unpacked', 'resources'),
    join(root, 'resources'),
    ...(existsSync(root) ? readdirSync(root) : [])
      .filter((n) => n.endsWith('.app'))
      .map((n) => join(root, n, 'Contents', 'Resources'))
  ]
  return candidates.find((c) => existsSync(c)) ?? null
}

function scanForPlaintext(dir, token, hits) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) scanForPlaintext(full, token, hits)
    } else if (entry.isFile()) {
      let size = 0
      try {
        size = statSync(full).size
      } catch {
        continue
      }
      if (size === 0 || size > MAX_SCAN_BYTES) continue
      try {
        if (readFileSync(full).includes(token)) hits.push(full)
      } catch {
        /* unreadable file: skip */
      }
    }
  }
}

/**
 * @param {{ dir: string, env?: Record<string, string | undefined>, localBlobPath?: string }} options
 * @returns {{ ok: boolean, messages: string[] }}
 */
export function checkEmbeddedOperatorEnroll({ dir, env = process.env, localBlobPath = LOCAL_BLOB }) {
  const messages = []
  const fail = (m) => ({ ok: false, messages: [...messages, `[check:embedded-operator-enroll] FAIL - ${m}`] })
  const required = enrollRequired(env)
  const staged = existsSync(localBlobPath)
  const resourcesDir = findResourcesDir(resolve(dir))
  const packagedPath = resourcesDir ? join(resourcesDir, ...PACKAGED_BLOB.split('/')) : null
  const packaged = packagedPath !== null && existsSync(packagedPath) && statSync(packagedPath).size > 0

  if (!staged && !packaged) {
    if (required) {
      return fail(
        `METIS_OPERATOR_ENROLL_REQUIRED=1 but the package carries no ${PACKAGED_BLOB}. ` +
          'Set METIS_OPERATOR_ENROLL_TOKEN for the build.'
      )
    }
    return {
      ok: true,
      messages: [
        '[check:embedded-operator-enroll] WARNING - no embedded Operator enrolment token: this build enrols through SSO only.'
      ]
    }
  }
  if (staged && !packaged)
    return fail(`a blob was staged for packaging but the package does not carry ${PACKAGED_BLOB}`)
  if (!staged && packaged) {
    return fail(`the package carries ${PACKAGED_BLOB} but none was staged for this build (stale output directory?)`)
  }

  let blob
  try {
    blob = JSON.parse(readFileSync(packagedPath, 'utf8'))
  } catch (e) {
    return fail(`packaged ${PACKAGED_BLOB} is not readable JSON: ${e.message}`)
  }
  if (!isEncryptedBlob(blob)) return fail(`packaged ${PACKAGED_BLOB} is not the AES-256-GCM blob shape`)
  let payload
  try {
    payload = parseEnrollPayload(decryptProxyKey(blob))
  } catch (e) {
    return fail(`packaged ${PACKAGED_BLOB} could not be decrypted with the shipped material: ${e.message}`)
  }
  if (!payload) {
    return fail(`packaged ${PACKAGED_BLOB} does not hold a METIS-ENR-1.<kid>.<secret> token and an https URL`)
  }
  const hits = []
  scanForPlaintext(resourcesDir, payload.token, hits)
  if (hits.length) {
    return fail(`PLAINTEXT LEAK - the enrolment token is present in cleartext in:\n  ${hits.join('\n  ')}`)
  }
  return {
    ok: true,
    messages: [
      `[check:embedded-operator-enroll] OK - encrypted enrolment blob bound to ${payload.operatorUrl}; no plaintext token in the package.`
    ]
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const dir = process.argv[2]
  if (!dir) {
    console.error('Usage: node scripts/check-embedded-operator-enroll.mjs <output-directory>')
    process.exit(2)
  }
  const result = checkEmbeddedOperatorEnroll({ dir })
  for (const m of result.messages) (result.ok ? console.log : console.error)(m)
  process.exit(result.ok ? 0 : 1)
}
