#!/usr/bin/env node
/**
 * embed-cloudflare-key.mjs — build step that turns the operator's METIS_PROXY_KEY into the ENCRYPTED blob
 * electron-builder packages (docs/CLOUDFLARE.md, src/main/embedded-cloudflare-key.ts).
 *
 * WHAT IT DOES
 *   - Reads the proxy key ONLY from process.env.METIS_PROXY_KEY. Never a hardcoded value, never a file.
 *   - If that env var is UNSET (open-source builds, CI without the secret, ordinary dev): NO-OP with a
 *     clear message. A keyless build is the normal, supported case and must never require the secret.
 *   - If SET: AES-256-GCM-encrypts it under a key derived (scrypt) from build-stable material
 *     (appId + obfuscation secret, in src/main/embedded-key-material.json) and writes the ciphertext blob
 *     to build/cloudflare-embed/key.json. The PLAINTEXT token is never written to disk — only the blob.
 *
 * SECURITY HONESTY: the blob is obfuscated, not secret. The passphrase ships in the app, so an attacker
 * with the binary can re-derive the key. This raises the bar over a plaintext file; it does not make the
 * token unextractable. The token-never-ships path is the Worker proxy. See docs/CLOUDFLARE.md.
 *
 * A NOTE ON THE TWO OPT-INS: this script writes the blob whenever METIS_PROXY_KEY is set. PACKAGING it
 * still requires the separate, explicit METIS_EMBED_CLOUDFLARE_KEY=1 (scripts/check-embedded-cloudflare-key.mjs)
 * — a deliberate double gate so an embed is never accidental. This script reminds the operator of that.
 *
 * Usage: node scripts/embed-cloudflare-key.mjs   (env: METIS_PROXY_KEY, optional)
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decryptProxyKey, encryptProxyKey } from './lib/embedded-cloudflare-crypto.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(repoRoot, 'build', 'cloudflare-embed')
const outFile = join(outDir, 'key.json')

const token = (process.env.METIS_PROXY_KEY ?? '').trim()
if (!token) {
  console.log(
    '[embed:cf-key] METIS_PROXY_KEY is not set — skipping the embedded-key step (this is the normal, keyless build).'
  )
  process.exit(0)
}

const blob = encryptProxyKey(token)

// Self-check before writing: a blob the runtime cannot decrypt would fail silently at first launch, not
// at build time. Prove the round-trip here, on the real parameters, so a broken build never ships.
const roundTrip = decryptProxyKey(blob)
if (roundTrip !== token) {
  throw new Error('[embed:cf-key] internal error — the encrypted blob did not decrypt back to the token; refusing to write it')
}

// Paranoia gate: the serialized blob must not contain the plaintext token anywhere (a bug in the shape,
// or a stray field, must never leak it into the file this whole step exists to keep encrypted).
const serialized = JSON.stringify(blob, null, 2)
if (serialized.includes(token)) {
  throw new Error('[embed:cf-key] internal error — the serialized blob contains the plaintext token; refusing to write it')
}

mkdirSync(outDir, { recursive: true })
writeFileSync(outFile, `${serialized}\n`, { mode: 0o600 })

console.log(`[embed:cf-key] wrote encrypted Cloudflare proxy key blob to ${outFile} (${serialized.length} bytes, ciphertext only).`)
console.log('[embed:cf-key] The plaintext token was NOT written to disk. The blob is OBFUSCATED, not secret — it is')
console.log('[embed:cf-key] extractable from the installer with effort (docs/CLOUDFLARE.md). Use a revocable,')
console.log('[embed:cf-key] rate-limited "embedded-default" label on the Worker, never the operator\'s own key.')
console.log('[embed:cf-key] To PACKAGE it you must also set METIS_EMBED_CLOUDFLARE_KEY=1 (the second, explicit opt-in).')
