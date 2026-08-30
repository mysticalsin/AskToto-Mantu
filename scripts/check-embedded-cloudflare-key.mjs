#!/usr/bin/env node
// check-embedded-cloudflare-key.mjs — packaging-time guard for the optional installer-embedded
// Cloudflare proxy key (docs/CLOUDFLARE.md, src/main/embedded-cloudflare-key.ts). Same disclosed,
// opt-in posture as scripts/check-cahe-package.mjs's Kimi-key gate: refuses a package that embeds the
// key unless a human explicitly set METIS_EMBED_CLOUDFLARE_KEY=1, printing a loud warning when it does.
//
// The embedded key now ships ENCRYPTED (AES-256-GCM, scripts/embed-cloudflare-key.mjs) rather than as a
// plaintext {"proxyKey":"…"} file. This gate therefore enforces two additional invariants the old
// plaintext format could not:
//   1. build/cloudflare-embed/key.json is the ENCRYPTED blob shape (ciphertext/iv/tag/salt) and carries NO
//      plaintext `proxyKey` field — a regression to the old format is rejected here, not shipped.
//   2. The plaintext token (recovered by decrypting the blob with the SAME material the app ships) does
//      NOT appear anywhere in the packaged app — app.asar or any packaged resource. This is the concrete
//      proof that the encryption actually kept the token out of the bytes, not just out of one file.
//
// The blob is still OBFUSCATION, not secrecy (the decryption material ships in the app); this gate does
// not claim otherwise. It proves the token is not sitting in the clear, which is the bar this format sets.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decryptProxyKey, isEncryptedBlob } from './lib/embedded-cloudflare-crypto.mjs'

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const outputDirectory = process.argv[2]
if (!outputDirectory) {
  throw new Error('Usage: node scripts/check-embedded-cloudflare-key.mjs <output-directory>')
}
const outputRoot = resolve(outputDirectory)

const localBundle = join(repositoryRoot, 'build', 'cloudflare-embed', 'key.json')
const embedIntended = existsSync(localBundle)
const ALLOW_EMBED = process.env.METIS_EMBED_CLOUDFLARE_KEY === '1'

if (embedIntended && !ALLOW_EMBED) {
  throw new Error(
    'build/cloudflare-embed/key.json is present but METIS_EMBED_CLOUDFLARE_KEY=1 was not set — refusing ' +
      'to package an embedded Cloudflare proxy key without the explicit opt-in. Set the env var to confirm, ' +
      'or delete the local key.json to build a normal keyless package.'
  )
}

/** Parse a blob file, insist it is the ENCRYPTED shape (never plaintext), and return the parsed object. */
function requireEncryptedBlob(path, label) {
  if (!existsSync(path) || statSync(path).size === 0) throw new Error(`${label}: missing or empty (${path})`)
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new Error(`${label}: not readable JSON (${path}): ${e.message}`)
  }
  if ('proxyKey' in parsed) {
    throw new Error(
      `${label}: carries a plaintext "proxyKey" field (${path}). The embedded key must ship ENCRYPTED — ` +
        're-run scripts/embed-cloudflare-key.mjs, which writes the ciphertext blob.'
    )
  }
  if (!isEncryptedBlob(parsed)) {
    throw new Error(`${label}: is not the expected AES-256-GCM blob shape (ciphertext/iv/tag/salt) at ${path}`)
  }
  return parsed
}

// Find the packaged resource dir regardless of platform layout (win-unpacked/resources, mac .app's
// Contents/Resources, or a bare 'resources' dir passed directly).
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

// Prove the plaintext token is NOT present anywhere in the packaged resources. Huge fetched binary asset
// trees (models/asr/ort/llama/ffmpeg/…) can never contain the token and would make this a multi-GB read,
// so they are skipped by name; everything else — crucially app.asar, where a leak would land — is scanned.
const SKIP_DIRS = new Set(['models', 'asr', 'ort', 'llama', 'ffmpeg', 'mac-helper', 'local-llm', 'local-ai'])
const MAX_SCAN_BYTES = 512 * 1024 * 1024
function scanForPlaintext(dir, token, hits) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      scanForPlaintext(full, token, hits)
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
        /* unreadable file — skip */
      }
    }
  }
}

const resourcesDir = findResourcesDir(outputRoot)

if (embedIntended) {
  // 1. The local bundle staged for packaging must be the encrypted shape.
  requireEncryptedBlob(localBundle, 'build/cloudflare-embed/key.json')

  // 2. The packaged copy must exist and also be the encrypted shape.
  if (!resourcesDir) throw new Error(`Expected an embedded key but found no packaged resources dir under ${outputRoot}`)
  const packaged = join(resourcesDir, 'cloudflare-embed', 'key.json')
  const packagedBlob = requireEncryptedBlob(packaged, 'packaged cloudflare-embed/key.json')

  // 3. Decrypt the packaged blob with the SAME material the app ships, then prove the recovered plaintext
  //    token appears NOWHERE in the packaged app. If encryption did its job, the only place the token
  //    exists is transiently in memory here — never in app.asar or any resource on disk.
  let token
  try {
    token = decryptProxyKey(packagedBlob)
  } catch (e) {
    throw new Error(`packaged cloudflare-embed/key.json could not be decrypted with the shipped material: ${e.message}`)
  }
  if (typeof token !== 'string' || token.length < 20) {
    throw new Error('packaged cloudflare-embed/key.json decrypted to something that is not a usable proxy key')
  }
  const hits = []
  scanForPlaintext(resourcesDir, token, hits)
  // The blob file itself holds only ciphertext, so it must NOT be a hit; if it somehow is, that is a real leak.
  if (hits.length) {
    throw new Error(
      `PLAINTEXT LEAK — the embedded Cloudflare token was found in cleartext in the packaged app:\n  ${hits.join('\n  ')}\n` +
        'The whole point of the encrypted blob is that this cannot happen. Refusing to ship.'
    )
  }

  console.log(`
⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️
⚠️  This build intentionally embeds a Cloudflare proxy key. It ships ENCRYPTED, but that is OBFUSCATION,
⚠️  not secrecy — the decryption material ships in the app, so the key is still EXTRACTABLE with effort.
⚠️  It must be its OWN "embedded-default" entry in the Worker's METIS_PROXY_KEYS, never the operator's
⚠️  own METIS_PROXY_KEY, and sized/rate-limited on the Worker side as a minimum-quota fallback. Be ready
⚠️  to rotate or revoke that one label independently. This is expected ONLY because
⚠️  METIS_EMBED_CLOUDFLARE_KEY=1 was set.
⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️
`)
  console.log(
    '[check:embedded-cloudflare-key] OK — encrypted Cloudflare proxy key explicitly allowed (METIS_EMBED_CLOUDFLARE_KEY=1); ' +
      'blob is ciphertext and no plaintext token is present in the packaged app.'
  )
} else {
  // Keyless build (the normal case): the packaged resource dir must NOT carry a real key either, in
  // case a stale file from a previous embedded build lingered in an output directory reused across runs.
  const packaged = resourcesDir ? join(resourcesDir, 'cloudflare-embed', 'key.json') : null
  if (packaged && existsSync(packaged) && statSync(packaged).size > 0) {
    throw new Error(`No local key.json to embed, but the package still carries one at ${packaged} (stale output dir?)`)
  }
  console.log('[check:embedded-cloudflare-key] OK — no embedded Cloudflare proxy key')
}
