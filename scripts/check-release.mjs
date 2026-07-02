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
//
// Optional artifact-size gate: GitHub hard-caps a single release asset at 2 GiB — an upload past that
// fails only at the very last step of `electron-builder --publish always`, after the full build +
// codesign + notarize run has already burned CI time and secrets budget. Set ASKTOTO_ARTIFACTS_DIR to
// the directory electron-builder wrote its .dmg/.zip/.exe into (e.g. right after `electron-builder`
// runs, before the publish step) to have this script also stat every such file in that directory and
// FAIL if any is >= 1.9 GiB (a safety buffer under the 2 GiB limit), WARN if any is >= 1.7 GiB. This
// check is opt-in and does nothing when the env var is unset — CI can wire it in when ready; it is not
// currently invoked anywhere in package.json or .github/workflows.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PLACEHOLDER_TOKEN = 'REPLACE-WITH'
const GIB = 1024 ** 3
const ARTIFACT_FAIL_BYTES = 1.9 * GIB
const ARTIFACT_WARN_BYTES = 1.7 * GIB

/** Stat every .dmg/.zip/.exe in ASKTOTO_ARTIFACTS_DIR (when set) against the GitHub 2 GiB asset limit.
 *  Returns false only on a genuine gate failure (oversize artifact or unreadable dir) — a false return
 *  should make the overall script exit non-zero, same as the update-channel checks above. */
function checkArtifactSizes() {
  const dir = process.env.ASKTOTO_ARTIFACTS_DIR
  if (!dir) return true
  let entries
  try {
    entries = readdirSync(dir)
  } catch (err) {
    console.error(`[check:release] FAIL — ASKTOTO_ARTIFACTS_DIR is set to "${dir}" but it could not be read.`)
    console.error(`[check:release] ${err?.message ?? err}`)
    return false
  }
  let ok = true
  for (const name of entries) {
    if (!/\.(dmg|zip|exe)$/i.test(name)) continue
    const size = statSync(join(dir, name)).size
    const gib = (size / GIB).toFixed(2)
    if (size >= ARTIFACT_FAIL_BYTES) {
      console.error(`[check:release] FAIL — ${name} is ${gib} GiB, at/over the ${(ARTIFACT_FAIL_BYTES / GIB).toFixed(1)} GiB gate (GitHub's hard per-asset limit is 2 GiB).`)
      ok = false
    } else if (size >= ARTIFACT_WARN_BYTES) {
      console.warn(`[check:release] WARN — ${name} is ${gib} GiB, approaching GitHub's 2 GiB per-asset limit.`)
    }
  }
  return ok
}

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
  process.exit(checkArtifactSizes() ? 0 : 1)
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
process.exit(checkArtifactSizes() ? 0 : 1)
