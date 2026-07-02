#!/usr/bin/env node
// Release preflight gate for AskToto's signed auto-update channel.
//
// Why this exists: electron-builder.yml ships with a `publish.url` placeholder that contains
// the `REPLACE-WITH` token. If a release is cut while that token is still present, the app will
// ship with a broken/un-configured update feed and CANNOT receive security patches (updater.ts
// detects the same token in app-update.yml and silently skips auto-update). This gate fails the
// release loudly so that never happens.
//
// CI / release integration: run `npm run check:release` BEFORE any publish step
// (e.g. before `npm run dist` / `dist:win` in your release workflow). It exits non-zero on a
// mis-configured feed, which will halt the pipeline. It is intentionally dependency-free —
// it reads electron-builder.yml as text and string/regex-checks it, so it needs no YAML parser.
//
// Self-test locally: `node scripts/check-release.mjs`

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PLACEHOLDER_TOKEN = 'REPLACE-WITH'

const here = dirname(fileURLToPath(import.meta.url))
const ymlPath = join(here, '..', 'electron-builder.yml')

let yml
try {
  yml = readFileSync(ymlPath, 'utf8')
} catch (err) {
  console.error(`[check:release] FAIL — could not read electron-builder.yml at ${ymlPath}`)
  console.error(`[check:release] ${err?.message ?? err}`)
  process.exit(1)
}

// Accept either a `github` provider (owner + repo) or a `generic` provider with an HTTPS url.
// Text-only checks; no YAML dependency.
const isGithub = /^\s*provider:\s*github\s*(#.*)?$/m.test(yml)
const owner = yml.match(/^\s*owner:\s*(\S+)\s*$/m)
const repo = yml.match(/^\s*repo:\s*(\S+)\s*$/m)
const urlMatch = yml.match(/^\s*url:\s*(\S.*?)\s*$/m)

if (isGithub) {
  if (!owner || !repo) {
    console.error('[check:release] FAIL — github publish needs both `owner:` and `repo:` in electron-builder.yml.')
    process.exit(1)
  }
  if ([owner[1], repo[1]].some((v) => v.includes(PLACEHOLDER_TOKEN))) {
    console.error('[check:release] FAIL — replace the placeholder github owner/repo before release.')
    process.exit(1)
  }
  // electron-builder's GitHub publisher defaults to DRAFT releases — and electron-updater resolves
  // versions from the public releases feed, which never contains drafts. Without releaseType: release,
  // every "release" lands invisible and no installed app can ever update.
  if (!/^\s*releaseType:\s*release\s*(#.*)?$/m.test(yml)) {
    console.error('[check:release] FAIL — publish.releaseType must be `release`.')
    console.error('[check:release] electron-builder defaults to draft releases, which electron-updater can never see:')
    console.error('[check:release] the pipeline would upload artifacts forever without any install ever updating.')
    process.exit(1)
  }
  console.log(`[check:release] OK — update channel = github releases (${owner[1]}/${repo[1]}, releaseType=release).`)
  process.exit(0)
}

if (!urlMatch) {
  console.error('[check:release] FAIL — no update channel. Set `provider: github` (owner+repo) OR `provider: generic` + https `url:`.')
  process.exit(1)
}

const url = urlMatch[1]

if (url.includes(PLACEHOLDER_TOKEN)) {
  console.error('[check:release] FAIL — update channel is not configured.')
  console.error(`[check:release] publish.url still contains the "${PLACEHOLDER_TOKEN}" placeholder: ${url}`)
  console.error('[check:release] Set a real HTTPS update host (or switch to provider: github) before release,')
  console.error('[check:release] or the shipped app cannot receive security patches.')
  process.exit(1)
}

if (!/^https:\/\//i.test(url)) {
  console.error('[check:release] FAIL — publish.url must be HTTPS (electron-updater rejects plain http).')
  console.error(`[check:release] Got: ${url}`)
  process.exit(1)
}

console.log(`[check:release] OK — update channel configured (publish.url = ${url}).`)
process.exit(0)
