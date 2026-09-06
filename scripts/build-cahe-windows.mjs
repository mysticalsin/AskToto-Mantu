#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const outputDirectory = resolve(process.env.METIS_CAHE_INSTALLER_OUTPUT_DIR || join('release', 'cahe-win'))

if (existsSync(outputDirectory) && readdirSync(outputDirectory).length) {
  throw new Error(
    `Refusing to overwrite a non-empty Cahê output directory: ${outputDirectory}. Use a new directory or remove its contents deliberately.`
  )
}
mkdirSync(outputDirectory, { recursive: true })

// Preflight: the Cahê pilot's whole point is a zero-setup embedded Kimi key. A build that silently ships
// WITHOUT a working key strands every pilot user on a keyless "kimi" provider they must configure by hand
// — the exact failure this guards. Validate the operator-provided key UP FRONT and fail loudly if it is
// missing or malformed, instead of producing a broken installer (previously the packaging gate would
// either reject a keyed build with a cryptic error, or a placeholder key file would sail through keyless).
// A valid key sets METIS_CAHE_EMBED_KEY=1 for the downstream gate (scripts/check-cahe-package.mjs) — running
// THIS script is the deliberate opt-in to embed it. Escape hatch: METIS_CAHE_ALLOW_KEYLESS=1 for a build
// that is intentionally keyless (users configure their own provider).
const KIMI_KEY_PATTERN = /sk-kimi-[A-Za-z0-9_-]{16,}/
const keyFile = resolve('build', 'cahe-kimi.local.json')
const allowKeyless = process.env.METIS_CAHE_ALLOW_KEYLESS === '1'
let embedKey = false
if (existsSync(keyFile)) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(keyFile, 'utf8'))
  } catch (error) {
    throw new Error(
      `build/cahe-kimi.local.json is not valid JSON (${error.message}). The Cahê pilot needs {"kimiApiKey":"sk-kimi-…"} — fix it, remove it, or set METIS_CAHE_ALLOW_KEYLESS=1.`
    )
  }
  const key = typeof parsed?.kimiApiKey === 'string' ? parsed.kimiApiKey.match(KIMI_KEY_PATTERN)?.[0] : undefined
  if (!key) {
    throw new Error(
      'build/cahe-kimi.local.json is present but has no valid "kimiApiKey" (expected an sk-kimi-… Kimi code key). ' +
        'The Cahê pilot embeds this key so the app works with zero setup; a build without it strands users on a keyless Kimi provider ' +
        'they must configure manually. Add a real sk-kimi- key, or set METIS_CAHE_ALLOW_KEYLESS=1 to build a deliberately keyless pilot.'
    )
  }
  embedKey = true
} else if (!allowKeyless) {
  throw new Error(
    'Cahê build needs build/cahe-kimi.local.json with {"kimiApiKey":"sk-kimi-…"} — the pilot embeds this key for zero-setup, and its ' +
      'absence is why an installed Cahê build asks users to import the key by hand. Create the (gitignored) file, or set ' +
      'METIS_CAHE_ALLOW_KEYLESS=1 to deliberately build a keyless pilot.'
  )
}

const environment = {
  ...process.env,
  METIS_CAHE_EDITION: '1',
  ...(embedKey ? { METIS_CAHE_EMBED_KEY: '1' } : {})
}
function run(command, args) {
  console.log(`\n$ ${command} ${args.join(' ')}`)
  // On Windows npm/npx are .cmd shims. execFileSync can't resolve them by bare name, and Node's
  // CVE-2024-27980 mitigation refuses to spawn a .cmd/.bat without shell:true (EINVAL) — so a Cahê
  // build from a Windows host previously died at the first `npm run` step. Route those through a shell.
  const useShell = process.platform === 'win32' && (command === 'npm' || command === 'npx')
  execFileSync(command, args, { cwd: process.cwd(), env: environment, stdio: 'inherit', shell: useShell })
}

run('node', ['scripts/check-no-dynamic-import.mjs'])
run('node', ['scripts/check-ffmpeg-sidecar.mjs', 'win', 'x64'])
run('node', ['scripts/check-sherpa-platform.mjs', 'win', 'x64'])
run('node', ['scripts/fetch-llama-server.mjs', 'win'])
run('node', ['scripts/check-llama-sidecar.mjs', 'win'])
run('node', ['scripts/fetch-local-model.mjs'])
run('node', ['scripts/check-local-model.mjs'])
run('node', ['scripts/fetch-models.mjs'])
run('npm', ['run', 'build:intelligence'])
run('npm', ['run', 'build'])
// Optional installer-embedded Cloudflare proxy key for the Cahê variant too (same as the mac + win
// chains): a no-op unless the operator set METIS_PROXY_KEY, and it must ALSO set METIS_EMBED_CLOUDFLARE_KEY=1
// for the packaging gate below to allow it. The blob ships ENCRYPTED (obfuscated, not secret — see
// src/main/embedded-cloudflare-key.ts). check-cloudflare-key-valid proves the key the Worker will accept.
run('node', ['scripts/embed-cahe-kimi-key.mjs'])
run('node', ['scripts/embed-cloudflare-key.mjs'])
run('node', ['scripts/check-cloudflare-key-valid.mjs'])
run('npx', [
  'electron-builder',
  '--config',
  'electron-builder.cahe.win.yml',
  '--win',
  'nsis',
  '--x64',
  '--publish',
  'never',
  `-c.directories.output=${outputDirectory}`
])
run('node', [
  'scripts/check-packaged-runtime.mjs',
  'win',
  join(outputDirectory, 'win-unpacked', 'resources'),
  '--post-sign',
  '--executable=Metis-Windows-Cahe.exe'
])
run('node', ['scripts/check-cahe-package.mjs', outputDirectory])
// Same encrypted-blob + no-plaintext-leak packaging gate the win/mac chains run. Keyless (the usual Cahê
// build, which embeds Kimi not Cloudflare) → prints OK and moves on.
run('node', ['scripts/check-embedded-cloudflare-key.mjs', outputDirectory])

console.log(`\nCahê installer ready: ${outputDirectory}`)
