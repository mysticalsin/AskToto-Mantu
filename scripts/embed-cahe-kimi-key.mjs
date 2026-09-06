#!/usr/bin/env node
/**
 * embed-cahe-kimi-key.mjs — build step that turns the operator's Cahê Kimi key into the ENCRYPTED
 * blob electron-builder packages (docs/cahe-windows-edition.md, src/main/cahe-embedded-key.ts).
 *
 * Reads the plaintext ONLY from the gitignored operator file build/cahe-kimi.local.json
 * ({"kimiApiKey":"sk-kimi-…"}). Writes ONLY the AES-256-GCM ciphertext blob to
 * build/cahe-embed/kimi.json (same encryptProxyKey material as the Cloudflare embed).
 *
 * SECURITY HONESTY: obfuscation, not secrecy — the passphrase ships in the app. Raises the bar over
 * a plaintext resources/cahe/kimi.json. Packaging still requires METIS_CAHE_EMBED_KEY=1.
 *
 * Usage: node scripts/embed-cahe-kimi-key.mjs
 *   No-op (exit 0) when build/cahe-kimi.local.json is absent (keyless / METIS_CAHE_ALLOW_KEYLESS builds).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decryptProxyKey, encryptProxyKey, isEncryptedBlob } from './lib/embedded-cloudflare-crypto.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const localPlain = join(repoRoot, 'build', 'cahe-kimi.local.json')
const outDir = join(repoRoot, 'build', 'cahe-embed')
const outFile = join(outDir, 'kimi.json')
const KIMI_KEY_PATTERN = /sk-kimi-[A-Za-z0-9_-]{16,}/

mkdirSync(outDir, { recursive: true })

if (!existsSync(localPlain)) {
  // Keyless: ensure no stale encrypted blob from a previous keyed build lingers for electron-builder.
  if (existsSync(outFile)) rmSync(outFile)
  console.log(
    '[embed:cahe-kimi] No build/cahe-kimi.local.json — skipping (keyless Cahê build). Cleared any stale build/cahe-embed/kimi.json.'
  )
  process.exit(0)
}

let parsed
try {
  parsed = JSON.parse(readFileSync(localPlain, 'utf8'))
} catch (e) {
  throw new Error(`[embed:cahe-kimi] build/cahe-kimi.local.json is not valid JSON: ${e.message}`)
}

const raw = typeof parsed?.kimiApiKey === 'string' ? parsed.kimiApiKey : ''
const key = raw.match(KIMI_KEY_PATTERN)?.[0]
if (!key) {
  throw new Error(
    '[embed:cahe-kimi] build/cahe-kimi.local.json has no valid sk-kimi-… kimiApiKey — refusing to embed.'
  )
}

const blob = encryptProxyKey(key)
const roundTrip = decryptProxyKey(blob)
if (roundTrip !== key) {
  throw new Error('[embed:cahe-kimi] internal error — encrypted blob did not decrypt back to the key; refusing to write')
}
if (!isEncryptedBlob(blob)) {
  throw new Error('[embed:cahe-kimi] internal error — encryptProxyKey did not produce the encrypted blob shape')
}
const serialized = JSON.stringify(blob, null, 2)
if (serialized.includes(key) || serialized.includes('kimiApiKey') || /sk-kimi-/.test(serialized)) {
  throw new Error('[embed:cahe-kimi] internal error — serialized blob leaks plaintext; refusing to write')
}

writeFileSync(outFile, `${serialized}\n`, { mode: 0o600 })
console.log(
  `[embed:cahe-kimi] wrote encrypted Cahê Kimi key blob to ${outFile} (${serialized.length} bytes, ciphertext only).`
)
console.log('[embed:cahe-kimi] The plaintext key was NOT written to build/cahe-embed/. OBFUSCATION, not secrecy.')
console.log('[embed:cahe-kimi] Packaging still requires METIS_CAHE_EMBED_KEY=1 (scripts/check-cahe-package.mjs).')
