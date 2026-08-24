#!/usr/bin/env node
// check-embedded-cloudflare-key.mjs — packaging-time guard for the optional installer-embedded
// Cloudflare proxy key (docs/CLOUDFLARE.md, src/main/embedded-cloudflare-key.ts). Same disclosed,
// opt-in posture as scripts/check-cahe-package.mjs's Kimi-key gate: refuses a package that embeds the
// key unless a human explicitly set METIS_EMBED_CLOUDFLARE_KEY=1, printing a loud warning when it does.
//
// Unlike the Kimi key (a fixed `sk-kimi-` prefix to pattern-match against), a METIS_PROXY_KEY is a bare
// `openssl rand -base64 32` string with no distinguishing shape — grepping packaged bytes for "looks like
// base64" would be both a false-positive minefield and would require embedding a copy of the real key
// literal in THIS script to test against (defeating the point). The existence of build/cloudflare-embed/
// key.json at packaging time is itself the signal: that file is only ever placed there deliberately (see
// electron-builder.yml's extraResources comment) and .gitignored, so this checks for that AND for the
// resource actually reaching the packaged output.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

const resourcesDir = findResourcesDir(outputRoot)
if (embedIntended) {
  if (!resourcesDir) throw new Error(`Expected an embedded key but found no packaged resources dir under ${outputRoot}`)
  const packaged = join(resourcesDir, 'cloudflare-embed', 'key.json')
  if (!existsSync(packaged) || statSync(packaged).size === 0) {
    throw new Error(`METIS_EMBED_CLOUDFLARE_KEY=1 but the package is missing ${packaged}`)
  }
  const parsed = JSON.parse(readFileSync(packaged, 'utf8'))
  if (typeof parsed.proxyKey !== 'string' || parsed.proxyKey.length < 20) {
    throw new Error(`${packaged} exists but has no usable "proxyKey" string`)
  }
  console.log(`
⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️
⚠️  This build intentionally embeds a Cloudflare proxy key — it is EXTRACTABLE from the installer.
⚠️  It must be its OWN "embedded-default" entry in the Worker's METIS_PROXY_KEYS, never the
⚠️  operator's own METIS_PROXY_KEY, and sized/rate-limited on the Worker side as a minimum-quota
⚠️  fallback. Be ready to rotate or revoke that one label independently. This is expected ONLY
⚠️  because METIS_EMBED_CLOUDFLARE_KEY=1 was set.
⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️
`)
  console.log('[check:embedded-cloudflare-key] OK — embedded Cloudflare proxy key explicitly allowed (METIS_EMBED_CLOUDFLARE_KEY=1)')
} else {
  // Keyless build (the normal case): the packaged resource dir must NOT carry a real key either, in
  // case a stale file from a previous embedded build lingered in an output directory reused across runs.
  const packaged = resourcesDir ? join(resourcesDir, 'cloudflare-embed', 'key.json') : null
  if (packaged && existsSync(packaged) && statSync(packaged).size > 0) {
    throw new Error(`No local key.json to embed, but the package still carries one at ${packaged} (stale output dir?)`)
  }
  console.log('[check:embedded-cloudflare-key] OK — no embedded Cloudflare proxy key')
}
