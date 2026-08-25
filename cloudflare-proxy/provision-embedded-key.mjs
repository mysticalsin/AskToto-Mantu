#!/usr/bin/env node
/**
 * Provision the installer-embedded key into the Worker's METIS_PROXY_KEYS — without anyone retyping it.
 *
 * WHY THIS EXISTS
 *
 * The manual route is `wrangler secret put METIS_PROXY_KEYS` and pasting `["embedded-default:<key>"]`.
 * That was done on 2026-08-25 and the Worker still answered 401. Not a malformed secret — a malformed one
 * returns HTTP 500 ("METIS_PROXY_KEYS is set but is not valid JSON"), which is not what came back. The
 * secret parsed as a valid array; it simply did not contain this key. A 44-character base64 string with
 * `+`, `/` and `=` in it, wrapped in JSON, typed into a prompt, is a paste waiting to go wrong.
 *
 * So the value is never retyped. It is read from build/cloudflare-embed/key.json.pending-deploy (or
 * key.json), wrapped in exactly the shape the Worker's parseProxyKeys expects, and piped straight to
 * wrangler's stdin. The key is never printed to the terminal or to any log.
 *
 * MERGES, never replaces. `wrangler secret put` overwrites the whole secret, so provisioning the embedded
 * key by hand silently revokes every other per-user key already in there. This reads the current value
 * first (via `wrangler secret list`, which reports names only — so existing VALUES cannot be read back)
 * and refuses rather than clobbering a secret it cannot see inside. That refusal is the point: quietly
 * cutting off other users to add one key is a worse outcome than an error message.
 *
 * Usage:
 *   node cloudflare-proxy/provision-embedded-key.mjs            # provision
 *   node cloudflare-proxy/provision-embedded-key.mjs --verify   # only check whether it is already live
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const verifyOnly = process.argv.includes('--verify')

const candidates = [
  join(repoRoot, 'build', 'cloudflare-embed', 'key.json'),
  join(repoRoot, 'build', 'cloudflare-embed', 'key.json.pending-deploy')
]
const bundlePath = candidates.find((p) => existsSync(p))
if (!bundlePath) {
  console.error('[provision] FAIL — no key bundle at build/cloudflare-embed/key.json[.pending-deploy].')
  process.exit(1)
}

let proxyKey
try {
  proxyKey = JSON.parse(readFileSync(bundlePath, 'utf8')).proxyKey
} catch (e) {
  console.error(`[provision] FAIL — ${bundlePath} is not readable JSON: ${e.message}`)
  process.exit(1)
}
if (typeof proxyKey !== 'string' || !proxyKey.trim()) {
  console.error(`[provision] FAIL — ${bundlePath} has no non-empty "proxyKey".`)
  process.exit(1)
}
console.log(`[provision] key loaded from ${bundlePath.replace(repoRoot, '.')} (${proxyKey.length} chars, not shown)`)

// The endpoint the app itself ships, read from source so this can never validate a different Worker.
const ipc = readFileSync(join(repoRoot, 'src', 'shared', 'ipc.ts'), 'utf8')
const workerUrl = ipc.match(/export const METIS_WORKER_URL = '([^']+)'/)?.[1]
if (!workerUrl) {
  console.error('[provision] FAIL — could not read METIS_WORKER_URL from src/shared/ipc.ts.')
  process.exit(1)
}
const chatUrl = `${workerUrl.replace(/\/+$/, '')}/chat/completions`

/** The model the app actually sends. `auto` is not a Workers AI id — the Worker forwards it and
 *  Cloudflare answers 400, which reads as a broken key when the key is fine. Read from the registry so
 *  this probe can never drift from what a real request looks like. */
function defaultCloudflareModel(repoRoot) {
  const src = readFileSync(join(repoRoot, 'src', 'shared', 'providers.ts'), 'utf8')
  const m = src.match(/defaultModel: '(@cf\/[^']+)'/)
  if (!m) throw new Error('could not read the Cloudflare defaultModel from src/shared/providers.ts')
  return m[1]
}

const MODEL = defaultCloudflareModel(repoRoot)

/** One real authenticated request. The only thing that actually answers "is this key live?". */
async function keyWorks() {
  try {
    const res = await fetch(chatUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${proxyKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 })
    })
    return { ok: res.ok, status: res.status }
  } catch (e) {
    return { ok: false, status: 0, error: e.message }
  }
}

const before = await keyWorks()
if (before.ok) {
  console.log(`[provision] OK — the Worker already accepts this key (HTTP ${before.status}). Nothing to do.`)
  process.exit(0)
}
if (verifyOnly) {
  console.error(`[provision] NOT LIVE — the Worker rejected this key (HTTP ${before.status || 'no response'}).`)
  process.exit(1)
}
console.log(`[provision] the Worker currently rejects this key (HTTP ${before.status}) — provisioning it.`)

// Refuse to clobber. `secret list` gives names only, so an existing METIS_PROXY_KEYS may hold other
// users' keys that this script cannot read and therefore cannot preserve.
let existing = ''
try {
  existing = execFileSync('npx', ['wrangler', 'secret', 'list'], { cwd: here, encoding: 'utf8', shell: true })
} catch {
  /* listing is best-effort; a fresh Worker has no secrets yet */
}
if (/METIS_PROXY_KEYS/.test(existing)) {
  console.error('')
  console.error('[provision] REFUSING — METIS_PROXY_KEYS already exists and its VALUE cannot be read back.')
  console.error('  `wrangler secret put` replaces the whole secret, so writing it here would silently revoke')
  console.error('  every other per-user key already in it. Add this one alongside them instead:')
  console.error('')
  console.error(`      cd cloudflare-proxy && npx wrangler secret put METIS_PROXY_KEYS`)
  console.error(`      # value: ["embedded-default:<proxyKey>", ...your existing entries]`)
  console.error(`      # the proxyKey is in ${bundlePath.replace(repoRoot, '.')}`)
  console.error('')
  console.error('  Or, if this is the only key, delete it first and re-run this script:')
  console.error('      npx wrangler secret delete METIS_PROXY_KEYS')
  process.exit(1)
}

// Piped to stdin, never typed. This is the failure mode the whole script exists to remove.
const payload = JSON.stringify([`embedded-default:${proxyKey}`])
const put = spawnSync('npx', ['wrangler', 'secret', 'put', 'METIS_PROXY_KEYS'], {
  cwd: here,
  input: payload,
  encoding: 'utf8',
  shell: true
})
if (put.status !== 0) {
  console.error(`[provision] FAIL — wrangler exited ${put.status}: ${(put.stderr || '').slice(0, 400)}`)
  process.exit(1)
}
console.log('[provision] secret uploaded; re-testing against the live Worker…')

const after = await keyWorks()
if (!after.ok) {
  console.error(`[provision] FAIL — still rejected after upload (HTTP ${after.status}).`)
  console.error('  The secret is set but the key does not match. Check that the deployed Worker includes')
  console.error('  parseProxyKeys (commit ddc9b78) — `npx wrangler deploy` if not.')
  process.exit(1)
}
console.log(`[provision] OK — the Worker now accepts the embedded key (HTTP ${after.status}).`)
console.log('[provision] next: rename key.json.pending-deploy -> key.json, then build with METIS_EMBED_CLOUDFLARE_KEY=1.')
