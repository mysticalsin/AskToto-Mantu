#!/usr/bin/env node
/**
 * Refuse to embed a Cloudflare proxy key the Worker will reject (MQA-254).
 *
 * WHY THIS EXISTS
 *
 * The point of the installer-embedded key is that a fresh install finishes onboarding with a working
 * provider and nothing to paste. That promise is worse than useless if the embedded key is not actually
 * provisioned on the Worker: onboarding then reports the provider READY — `providerReady` is satisfied by
 * a stored key plus the default endpoint, neither of which knows whether the key works — and the very
 * first question fails with a 401. A user who pasted nothing has no idea what to fix.
 *
 * That is not hypothetical. Before METIS_PROXY_KEYS was provisioned on 2026-08-25 the Worker answered:
 *
 *     POST /v1/chat/completions  ->  401 {"error":{"message":"Invalid proxy key."}}
 *
 * Shipping then would have produced exactly the failure above on every fresh install, with the app
 * insisting it was configured. It now answers 200, which is the state this gate exists to keep true.
 *
 * A note on the request shape, because it cost an hour: the probe must send the model the APP sends
 * (@cf/... from the provider registry). `model: "auto"` is not a Workers AI id — the Worker accepts the
 * KEY, forwards the request, and Cloudflare returns 400. That looks like a broken key and is not one.
 *
 * So the embed is gated on PROOF, not intent: one real request to the real Worker with the real key. It
 * either answers or the package is not built. `check-embedded-cloudflare-key.mjs` already proves the key
 * is embedded deliberately; this proves it is embedded *usefully*, which is the half that matters to a
 * user.
 *
 * Skipped entirely when there is no key to embed — a keyless build is the normal, supported case and must
 * not need network access to produce.
 *
 * Usage: node scripts/check-cloudflare-key-valid.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = join(repoRoot, 'build', 'cloudflare-embed', 'key.json')

if (!existsSync(bundlePath)) {
  console.log('[check:cf-key] OK — no embedded key bundle, nothing to validate (normal keyless build).')
  process.exit(0)
}

let proxyKey
try {
  proxyKey = JSON.parse(readFileSync(bundlePath, 'utf8')).proxyKey
} catch (e) {
  console.error(`[check:cf-key] FAIL — build/cloudflare-embed/key.json is not readable JSON: ${e.message}`)
  process.exit(1)
}
if (typeof proxyKey !== 'string' || !proxyKey.trim()) {
  console.error('[check:cf-key] FAIL — key.json has no non-empty "proxyKey".')
  process.exit(1)
}

// The default the app itself ships as cloudflareBaseUrl, read from source rather than duplicated here —
// validating a different endpoint than the one users hit would proves nothing.
const ipc = readFileSync(join(repoRoot, 'src', 'shared', 'ipc.ts'), 'utf8')
const urlMatch = ipc.match(/export const METIS_WORKER_URL = '([^']+)'/)
if (!urlMatch) {
  console.error('[check:cf-key] FAIL — could not read METIS_WORKER_URL from src/shared/ipc.ts.')
  process.exit(1)
}
const endpoint = `${urlMatch[1].replace(/\/+$/, '')}/chat/completions`

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

const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), 45_000)
let res
try {
  res = await fetch(endpoint, {
    method: 'POST',
    signal: controller.signal,
    headers: { Authorization: `Bearer ${proxyKey}`, 'Content-Type': 'application/json' },
    // Smallest request that still exercises auth AND routing. A HEAD or an unauthenticated ping would
    // prove the Worker is up without proving this key is accepted, which is the entire question.
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 })
  })
} catch (e) {
  clearTimeout(timer)
  console.error(`[check:cf-key] FAIL — could not reach the Worker at ${endpoint}: ${e.message}`)
  console.error('[check:cf-key]   A key that cannot be verified must not ship: onboarding would report the')
  console.error('[check:cf-key]   provider ready and the first question would fail with no way to diagnose it.')
  process.exit(1)
}
clearTimeout(timer)

if (res.status === 401 || res.status === 403) {
  console.error(`[check:cf-key] FAIL — the Worker REJECTED the embedded key (HTTP ${res.status}).`)
  console.error('')
  console.error('  The key exists locally but is not in the Worker\'s METIS_PROXY_KEYS, so every fresh')
  console.error('  install would finish onboarding "configured" and then 401 on the first question.')
  console.error('')
  console.error('  Provision it (the value is in build/cloudflare-embed/key.json):')
  console.error('      cd cloudflare-proxy && npx wrangler secret put METIS_PROXY_KEYS')
  console.error('      # value: ["embedded-default:<the proxyKey from key.json>"]')
  console.error('')
  console.error('  Then re-run this check. Until it passes, build without the key bundle instead.')
  process.exit(1)
}

if (!res.ok) {
  // Not an auth failure — the key is accepted but something else is wrong upstream. Still refuse: the
  // promise being made to the user is "this works out of the box", and it demonstrably does not.
  const body = await res.text().catch(() => '')
  console.error(`[check:cf-key] FAIL — Worker answered HTTP ${res.status} for an accepted key: ${body.slice(0, 200)}`)
  process.exit(1)
}

console.log(`[check:cf-key] OK — the Worker accepted the embedded key (HTTP ${res.status}); a fresh install needs no pasted key.`)
