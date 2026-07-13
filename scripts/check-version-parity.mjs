#!/usr/bin/env node
// Release preflight gate: the pushed tag must exactly match package.json's version.
//
// Why this exists: electron-builder derives the published release tag, artifact filenames, and the
// `version:` field written into latest.yml/latest-mac.yml entirely from package.json's `version`, never
// from the git tag that triggered the release workflow. A mismatched tag (e.g. tag v1.0.1 pushed while
// package.json is still "1.0.0") makes electron-builder publish onto the OLD release (v1.0.0) instead of
// creating a new one — clobbering its assets and leaving every already-installed v1.0.0 client with no
// version increase to update to. Fail here, before any build work starts, not after.
//
// CI integration: run as the FIRST step of every release job (right after checkout, before the
// ffmpeg-sidecar / signing-secret gates) — see .github/workflows/release.yml.
//
// Self-test locally: GITHUB_REF_NAME=v1.0.0 node scripts/check-version-parity.mjs
//
// Optional duplicate-release guard: when a token is available, reject an already-public release but
// allow the workflow to resume its own incomplete draft. Network/auth failures fail closed; only an
// explicit GitHub 404 means the tag has no release yet.

import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

let pkg
try {
  pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
} catch (err) {
  console.error('[check:version-parity] FAIL — could not read/parse package.json.')
  console.error(`[check:version-parity] ${err?.message ?? err}`)
  process.exit(1)
}

const ref = process.env.GITHUB_REF_NAME
if (!ref) {
  console.error('[check:version-parity] FAIL — GITHUB_REF_NAME is not set; this gate only runs meaningfully on a tag-triggered workflow.')
  process.exit(1)
}

const expectedTag = `v${pkg.version}`
if (ref !== expectedTag) {
  console.error(`[check:version-parity] FAIL — pushed tag "${ref}" does not match package.json's version "${pkg.version}" (expected "${expectedTag}").`)
  console.error('[check:version-parity] Bump package.json\'s version before tagging, or delete/re-push the correct tag —')
  console.error('[check:version-parity] a mismatch makes electron-builder publish onto the wrong (existing) GitHub release.')
  process.exit(1)
}
console.log(`[check:version-parity] OK — tag ${ref} matches package.json version ${pkg.version}.`)

let yml
try {
  yml = readFileSync(join(here, '..', 'electron-builder.yml'), 'utf8')
} catch {
  process.exit(0)
}
const owner = yml.match(/^\s*owner:\s*(\S+)\s*$/m)?.[1]
const repo = yml.match(/^\s*repo:\s*(\S+)\s*$/m)?.[1]
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN

if (!owner || !repo || !token) {
  console.log('[check:version-parity] Skipping duplicate-release check (no owner/repo in electron-builder.yml, or no token in this environment).')
  process.exit(0)
}

const result = spawnSync(
  'gh',
  ['api', `repos/${owner}/${repo}/releases/tags/${encodeURIComponent(ref)}`, '--jq', '.draft'],
  {
  encoding: 'utf8',
  env: { ...process.env, GH_TOKEN: token },
  }
)
if (result.status === 0) {
  if (result.stdout.trim() === 'true') {
    console.log(`[check:version-parity] OK — resuming the existing draft for ${ref} on ${owner}/${repo}.`)
    process.exit(0)
  }
  console.error(`[check:version-parity] FAIL — a public release already exists for tag ${ref} on ${owner}/${repo}.`)
  console.error('[check:version-parity] Refusing to overwrite published assets. Bump package.json\'s version and tag a new release instead.')
  process.exit(1)
}
const failure = `${result.stderr || ''}\n${result.stdout || ''}`.trim()
if (!/HTTP 404/i.test(failure)) {
  console.error(`[check:version-parity] FAIL — could not verify whether ${ref} already exists on ${owner}/${repo}.`)
  console.error(`[check:version-parity] ${failure || `gh exited with status ${result.status}`}`)
  process.exit(1)
}
console.log(`[check:version-parity] OK — no existing release for ${ref} on ${owner}/${repo}.`)
