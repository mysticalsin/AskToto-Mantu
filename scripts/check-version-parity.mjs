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
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { feedRepository, ghFeed, planPublication, PLATFORMS } from './publish-release.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const platform = process.argv[2]
if (!Object.hasOwn(PLATFORMS, platform)) {
  console.error('[check:version-parity] usage: check-version-parity.mjs <mac|win>')
  process.exit(1)
}

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

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN

if (!token) {
  console.log('[check:version-parity] Skipping the release-feed check (no token in this environment).')
  process.exit(0)
}

try {
  const repo = feedRepository(readFileSync(join(here, '..', 'electron-builder.yml'), 'utf8'))
  const releases = ghFeed({ repo, token }).releasesTagged(ref)
  const plan = planPublication(platform, pkg.version, releases)
  console.log(`[check:version-parity] OK — ${PLATFORMS[platform].label} can ${plan.action} ${ref} on ${repo}.`)
} catch (err) {
  console.error(`[check:version-parity] FAIL — could not verify that ${PLATFORMS[platform].label} can publish ${ref}.`)
  console.error(`[check:version-parity] ${err?.message ?? err}`)
  process.exit(1)
}
