#!/usr/bin/env node
/**
 * One-command rotation for the disclosed, revocable installer-embedded product keys.
 *
 * These are NOT Cloudflare account tokens and NOT operator live secrets. They are labeled
 * product keys (`embedded-default` / Cahê pilot) that a packed asar can recover by design.
 * Rotation is how you revoke a leaked installer's key without expanding its scope.
 *
 *   npm run rotate:embedded-keys
 *
 * Writes a new gitignored `build/cloudflare-embed/key.json` in the same encrypted blob shape
 * scripts/embed-cloudflare-key.mjs produces (the packaging gate rejects a plaintext `proxyKey`
 * file). Then the operator must:
 *   1. Add the new key to the Worker `METIS_PROXY_KEYS` under label `embedded-default`.
 *   2. Remove the previous `embedded-default` entry.
 *   3. Rebuild the installer with `METIS_EMBED_CLOUDFLARE_KEY=1`.
 *
 * Cahê Kimi (if that edition is shipping): replace `build/cahe-kimi.local.json` and revoke
 * the old `sk-kimi-` key at the vendor. This script does not touch account tokens.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encryptProxyKey } from './lib/embedded-cloudflare-crypto.mjs'

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function parseOutPath(argv) {
  const flag = argv.indexOf('--out')
  if (flag !== -1 && argv[flag + 1]) return resolve(argv[flag + 1])
  return join(repositoryRoot, 'build', 'cloudflare-embed', 'key.json')
}

export function generateEmbeddedProxyKey() {
  return randomBytes(32).toString('base64')
}

/** Writes the encrypted blob the app decrypts at runtime, never the plaintext key. The plaintext is
 *  returned to the caller (printed once by the CLI) so it can be put on the Worker. */
export function writeEmbeddedProxyKey(dest, key = generateEmbeddedProxyKey()) {
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, `${JSON.stringify(encryptProxyKey(key), null, 2)}\n`, { mode: 0o600 })
  return { dest, key }
}

function runCli(argv = process.argv.slice(2)) {
  const dest = parseOutPath(argv)
  const { key } = writeEmbeddedProxyKey(dest)
  console.log(`Wrote a new disclosed embedded proxy key to ${dest} (gitignored, encrypted blob).`)
  console.log('Operator next steps (do not put this value in CLOUDFLARE_API_TOKEN or METIS_PROXY_KEY):')
  console.log('  1. wrangler secret put METIS_PROXY_KEYS')
  console.log('     Keep every other labeled key. Replace only the embedded-default entry with:')
  console.log(`     "embedded-default:${key}"`)
  console.log('  2. Remove the previous embedded-default key from that array (revokes old installers).')
  console.log('  3. Rebuild with METIS_EMBED_CLOUDFLARE_KEY=1 so the new installer ships the new key.')
  console.log('Cahê edition only: rotate build/cahe-kimi.local.json and revoke the old sk-kimi- key at the vendor.')
  return { dest, key }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) runCli()

export { parseOutPath, runCli }
