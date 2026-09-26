#!/usr/bin/env node
// New release gate (design §2.7): proves installs of THIS signed Windows release will accept the NEXT
// identically-signed update, using the exact code path the installed app runs at update time —
// electron-updater's own windowsExecutableCodeSignatureVerifier — instead of trusting that whatever
// electron-builder wrote into app-update.yml is sane.
//
// Why this exists: a silently-unpinned app-update.yml (publisherName missing/empty while
// win.verifyUpdateCodeSignature is true) is exactly the state every public Metis-Releases build is in
// today (design §3.2) — no pin means NsisUpdater skips signature verification entirely (only the
// sha512 in latest.yml then protects a download). This gate makes that state impossible to publish.
//
// Run AFTER verify-signing, right before the release artifacts are uploaded:
//   node scripts/check-update-publisher.mjs [releaseDir=release]
//
// Reads:
//   <releaseDir>/win-unpacked/resources/app-update.yml   the pin electron-builder actually wrote
//     (PublishManager.js:87-89; the installed app reads this same file, AppUpdater.js:157)
//   <releaseDir>/Metis-Setup-<version>.exe                the artifact that pin must accept
//   package.json version                                  expected version / installer filename
//   electron-builder.yml win.verifyUpdateCodeSignature     the repo's fixed trust-policy flag
//   WIN_UPDATE_PUBLISHER_NAMES (optional)                  the intended pin list (design §3.3), JSON
//                                                           array of strings
//
// Windows only: it calls the installed electron-updater's PowerShell-based verifier.

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

/** Normalizes an app-update.yml `publisherName` (absent, a single string, or an array) to an array,
 *  or `null` when there is no pin at all — the exact shape NsisUpdater.verifySignature normalizes to
 *  (NsisUpdater.js:99) and the exact shape that makes it skip verification (NsisUpdater.js:87-90). */
export function publisherList(value) {
  if (value == null) return null
  return Array.isArray(value) ? value : [value]
}

/** Parses the optional WIN_UPDATE_PUBLISHER_NAMES env input: a JSON array of one or more non-empty
 *  strings. An unset/empty value is fine (no transitional-pin check); anything else malformed is not —
 *  never silently ignored, since it is meant to be the intended long-term pin (design §3.3/§3.4). */
export function parseUpdatePublisherNamesEnv(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return { ok: true, list: null }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: 'WIN_UPDATE_PUBLISHER_NAMES is not valid JSON' }
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((entry) => typeof entry === 'string' && entry.trim())) {
    return { ok: false, error: 'WIN_UPDATE_PUBLISHER_NAMES must be a JSON array of one or more non-empty strings' }
  }
  return { ok: true, list: parsed }
}

/** The pin-shape checks from design §2.7 items 2-3, independent of any real signature verification. */
export function updatePublisherProblem({ publisherName, verifyUpdateCodeSignature, expectedList }) {
  const list = publisherList(publisherName)
  if (verifyUpdateCodeSignature && (!list || list.length === 0)) {
    return 'app-update.yml has no publisherName while win.verifyUpdateCodeSignature is true — installs of ' +
      'this release would accept ANY future update with no signature check at all (only the sha512 in latest.yml)'
  }
  if (expectedList && list) {
    const matches = list.length === expectedList.length && list.every((name, index) => name === expectedList[index])
    if (!matches) {
      return `app-update.yml publisherName ${JSON.stringify(list)} does not exactly match ` +
        `WIN_UPDATE_PUBLISHER_NAMES ${JSON.stringify(expectedList)}`
    }
  }
  return null
}

/** Reads the repo's fixed win.verifyUpdateCodeSignature policy flag (electron-builder.yml:292). This is
 *  a deliberate constant, never a build override (design AUTHORITY: "no weakening of existing trust
 *  policy... verifyUpdateCodeSignature stays true") — a missing or unparseable flag fails closed
 *  (treated as enabled) rather than silently allowing an unpinned release. */
export function verifyUpdateCodeSignatureEnabled(repoRoot = REPO_ROOT) {
  const text = readFileSync(join(repoRoot, 'electron-builder.yml'), 'utf8')
  const match = text.match(/^\s*verifyUpdateCodeSignature:\s*(true|false)\s*$/m)
  return !match || match[1] === 'true'
}

/** js-yaml is resolved through electron-updater's OWN dependency tree (its package.json declares
 *  "js-yaml": "^4.1.0" directly — the same library AppUpdater.js:9 uses to read this very file at
 *  runtime), not the repo's hoisted top-level node_modules. That stays correct even if a future
 *  lockfile change stops hoisting it (scripts/updater-yaml-compat.test.ts:24-27 takes the same
 *  through-the-real-consumer approach for a different electron-updater dependency). */
export function loadAppUpdateYaml(path) {
  const updaterEntry = require.resolve('electron-updater')
  const jsYamlPath = require.resolve('js-yaml', { paths: [updaterEntry] })
  const { load } = require(jsYamlPath)
  return load(readFileSync(path, 'utf8'))
}

const NOOP_LOGGER = { info() {}, warn() {}, error() {} }

/** design §2.7 item 4: calls the INSTALLED electron-updater's own verifier — the exact code that will
 *  judge the next update (NsisUpdater.js:16, 84-100) — and requires `null` (its "accepted" result). */
function defaultVerifySignature(publisherNames, exePath, logger) {
  const verifierPath = require.resolve('electron-updater/out/windowsExecutableCodeSignatureVerifier.js')
  const { verifySignature } = require(verifierPath)
  return verifySignature(publisherNames, exePath, logger)
}

/** Pure orchestration: given already-resolved paths and policy, decide pass/fail and (unless a pin-shape
 *  problem already ends it) call the real signature acceptance check. `verifySignature` is injectable so
 *  tests can assert it is called with the parsed publisher list and the exe path, without Windows. */
export async function checkUpdatePublisher({
  appUpdatePath,
  setupExePath,
  verifyUpdateCodeSignature,
  expectedList = null,
  loadAppUpdateYaml: loadYaml = loadAppUpdateYaml,
  verifySignature = defaultVerifySignature
}) {
  let config
  try {
    config = loadYaml(appUpdatePath)
  } catch (error) {
    throw new Error(`could not read ${appUpdatePath}: ${error.message}`)
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`${appUpdatePath} did not parse to a YAML mapping`)
  }
  const problem = updatePublisherProblem({ publisherName: config.publisherName, verifyUpdateCodeSignature, expectedList })
  if (problem) throw new Error(problem)

  const list = publisherList(config.publisherName)
  const result = list ? await verifySignature(list, setupExePath, NOOP_LOGGER) : null
  if (result !== null) {
    throw new Error(
      'installs of this release would REJECT its own next update: the identity that signed ' +
      `${setupExePath} does not satisfy the pin (${JSON.stringify(list)}) baked into its own app-update.yml. ` +
      `Verifier detail: ${result}`
    )
  }
  return { publisherName: list, appUpdatePath, setupExePath }
}

async function main() {
  if (platform() !== 'win32') {
    console.error('[check:update-publisher] FAIL — this gate only runs on Windows (it calls the installed ' +
      'electron-updater signature verifier, which shells out to powershell.exe)')
    process.exit(2)
  }
  const releaseDir = resolve(process.argv[2] || 'release')
  const version = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version
  const appUpdatePath = join(releaseDir, 'win-unpacked', 'resources', 'app-update.yml')
  const setupExePath = join(releaseDir, `Metis-Setup-${version}.exe`)

  const envList = parseUpdatePublisherNamesEnv(process.env.WIN_UPDATE_PUBLISHER_NAMES)
  if (!envList.ok) throw new Error(envList.error)

  const result = await checkUpdatePublisher({
    appUpdatePath,
    setupExePath,
    verifyUpdateCodeSignature: verifyUpdateCodeSignatureEnabled(REPO_ROOT),
    expectedList: envList.list
  })
  console.log(
    `[check:update-publisher] OK — ${appUpdatePath} pins ${JSON.stringify(result.publisherName)}; ` +
    `${setupExePath} satisfies its own pin`
  )
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(`[check:update-publisher] FAIL — ${error.message}`)
    process.exit(1)
  })
}
