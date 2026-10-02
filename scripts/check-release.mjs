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
// Optional artifact-size gate: GitHub hard-caps a single release asset at 2 GiB. Set
// ASKTOTO_ARTIFACTS_DIR to the directory electron-builder wrote its .dmg/.zip/.exe into (`release/` per
// electron-builder.yml's directories.output) to have this script also stat every such file in that
// directory and FAIL if any is >= 1.9 GiB (a safety buffer under the 2 GiB limit), WARN if any is >= 1.7
// GiB. This check is opt-in and does nothing when the env var is unset. `npm run release` / `release:win`
// already run this script (without the env var) as an update-channel preflight BEFORE electron-builder
// has produced any artifacts. release.yml re-invokes it with ASKTOTO_ARTIFACTS_DIR after each native
// build but before artifact upload or publication, making size a hard pre-publication gate.
//
// Install-script gate (M2-0457): the same directory must never carry a customer-reachable install helper.
// Any .command or .sh file fails the gate, and so does any non-installer file (anything other than
// .dmg/.zip/.exe/.blockmap) whose text runs `xattr` against com.apple.quarantine, so a renamed helper
// cannot slip through. Installers are multi-GB and are never opened for the text scan.

import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PLACEHOLDER_TOKEN = 'REPLACE-WITH'
const GIB = 1024 ** 3
const ARTIFACT_FAIL_BYTES = 1.9 * GIB
const ARTIFACT_WARN_BYTES = 1.7 * GIB
const INSTALLER_PATTERN = /\.(dmg|zip|exe)$/i
const SCAN_SKIP_PATTERN = /\.(dmg|zip|exe|blockmap)$/i
const INSTALL_SCRIPT_PATTERN = /\.(command|sh)$/i
const QUARANTINE_CLEARING_PATTERN = /xattr\b[^\n]*com\.apple\.quarantine/i
// A helper is a short text file; bounding the read keeps a large or padded non-installer cheap to scan.
const SCAN_BYTES = 1024 * 1024

function readPrefix(path) {
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(SCAN_BYTES)
    return buffer.toString('utf8', 0, readSync(fd, buffer, 0, SCAN_BYTES, 0))
  } finally {
    closeSync(fd)
  }
}

/** Refuse quarantine-clearing install helpers in the artifacts directory. Returns false on any finding. */
function checkInstallScripts(dir, entries) {
  let ok = true
  for (const name of entries) {
    if (INSTALL_SCRIPT_PATTERN.test(name)) {
      console.error(`[check:release] FAIL — ${name} is an install script; release assets must not include .command or .sh files.`)
      ok = false
      continue
    }
    if (SCAN_SKIP_PATTERN.test(name)) continue
    const path = join(dir, name)
    if (!statSync(path).isFile()) continue
    if (QUARANTINE_CLEARING_PATTERN.test(readPrefix(path))) {
      console.error(`[check:release] FAIL — ${name} runs xattr against com.apple.quarantine; release assets must not clear macOS quarantine.`)
      ok = false
    }
  }
  return ok
}

/** Refuse install scripts in ASKTOTO_ARTIFACTS_DIR (when set) and stat every .dmg/.zip/.exe in it against the
 *  GitHub 2 GiB asset limit.
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
  let ok = checkInstallScripts(dir, entries)
  for (const name of entries) {
    if (!INSTALLER_PATTERN.test(name)) continue
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
