#!/usr/bin/env node
// sign-win.mjs — Authenticode-sign the built Windows artifacts with signtool + an RFC3161 timestamp.
//
// Why this exists alongside electron-builder's own signing: on a non-elevated Windows box,
// electron-builder's bundled winCodeSign archive fails to extract (it contains macOS .dylib SYMLINKS,
// and creating symlinks needs SeCreateSymbolicLinkPrivilege / Developer Mode / admin). That aborts the
// whole `--win` signing path even for a Windows-only build. This script sidesteps it: build UNSIGNED,
// then sign the deliverables here using a signtool.exe found on the machine (Windows SDK first, then the
// signtool that already lives inside electron-builder's winCodeSign cache — the Windows tools in that
// archive extract fine; only the darwin symlinks don't).
//
// CI with a proper signing runner keeps using electron-builder's native signing; this is the
// local / non-admin path. Both require the expected publisher and a trusted timestamp; timestamping
// requires access to the configured RFC3161 service.
//
// Usage:
//   WIN_CSC_LINK=path\to\cert.pfx WIN_CSC_KEY_PASSWORD=... WIN_CSC_EXPECTED_SUBJECT=... node scripts/sign-win.mjs [artifactsDir]
//   (defaults: artifactsDir=release; timestamp=http://timestamp.digicert.com)
// Exits non-zero if any target fails to sign or verify.
// signtool's existing PFX mode requires /p on argv. Never echo that command, its error, or child output;
// this helper does not remove the OS-level process-argument exposure of that signing input method.

import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, platform } from 'node:os'
import { windowsPowerShell, windowsSignatureCommand, windowsSignatureProblem } from './lib/signing-policy.mjs'

if (platform() !== 'win32') {
  console.error('[sign-win] UNSUPPORTED_HOST — Windows is required; no artifacts were signed or verified')
  process.exit(2)
}

const CERT = process.env.WIN_CSC_LINK
const PASS = process.env.WIN_CSC_KEY_PASSWORD
const EXPECTED_SIGNER = String(process.env.WIN_CSC_EXPECTED_SUBJECT || '').trim()
const TS = process.env.WIN_TIMESTAMP_URL || 'http://timestamp.digicert.com'
const ARTIFACTS = process.argv.slice(2).find((a) => !a.startsWith('--')) || process.env.ASKTOTO_ARTIFACTS_DIR || 'release'

function validPath(value, directory = false) {
  if (!value) return false
  try {
    const entry = statSync(value)
    return directory ? entry.isDirectory() : entry.isFile()
  } catch {
    return false
  }
}

if (!validPath(CERT)) {
  console.error('[sign-win] CERTIFICATE_CONFIG_INVALID — WIN_CSC_LINK must reference an accessible local certificate file')
  process.exit(2)
}
if (!PASS) {
  console.error('[sign-win] PASSWORD_CONFIG_MISSING — WIN_CSC_KEY_PASSWORD is required')
  process.exit(2)
}
if (!EXPECTED_SIGNER) {
  console.error('[sign-win] PUBLISHER_CONFIG_MISSING — WIN_CSC_EXPECTED_SUBJECT is required')
  process.exit(2)
}
if (!validPath(ARTIFACTS, true)) {
  console.error('[sign-win] ARTIFACTS_CONFIG_INVALID — an accessible artifacts directory is required')
  process.exit(2)
}

function walk(dir, test, depth = 3) {
  const hits = []
  const rec = (d, lvl) => {
    if (lvl < 0) return
    let entries = []
    try {
      entries = readdirSync(d)
    } catch {
      return
    }
    for (const name of entries) {
      const p = join(d, name)
      let s
      try {
        s = statSync(p)
      } catch {
        continue
      }
      if (s.isDirectory()) rec(p, lvl - 1)
      else if (test(name)) hits.push(p)
    }
  }
  rec(dir, depth)
  return hits
}

/** Find a usable signtool.exe: Windows SDK bin first, then electron-builder's winCodeSign cache. */
function findSigntool() {
  const sdkRoots = ['C:\\Program Files (x86)\\Windows Kits\\10\\bin', 'C:\\Program Files\\Windows Kits\\10\\bin']
  for (const root of sdkRoots) {
    const hits = walk(root, (n) => n.toLowerCase() === 'signtool.exe', 4).filter((p) => /x64/i.test(p))
    if (hits.length) return hits.sort().reverse()[0] // newest SDK build
  }
  const cache = join(homedir(), 'AppData', 'Local', 'electron-builder', 'Cache', 'winCodeSign')
  const cacheHits = walk(cache, (n) => n.toLowerCase() === 'signtool.exe', 5).filter((p) => /windows-10[\\/]x64/i.test(p))
  if (cacheHits.length) return cacheHits[0]
  return null
}

const signtool = findSigntool()
if (!signtool) {
  console.error('[sign-win] SIGNTOOL_NOT_FOUND — install the Windows SDK or provision electron-builder\'s winCodeSign cache')
  process.exit(2)
}
console.log('[sign-win] signing tool and artifacts directory ready')

// Sign .exe outputs in the artifacts directory and one directory level below it. This includes Setup
// and Portable installers, plus win-unpacked's app executable when present; not every target is a
// distributable installer. Keep the existing traversal depth for the local build workflow.
const targets = walk(ARTIFACTS, (n) => /\.exe$/i.test(n), 1)
if (!targets.length) {
  console.error('[sign-win] ARTIFACTS_EMPTY — no .exe artifacts found')
  process.exit(2)
}

let failures = 0
const policyFailureCategories = new Map([
  ['Authenticode signer does not exactly match WIN_CSC_EXPECTED_SUBJECT', 'PUBLISHER_MISMATCH'],
  ['Authenticode signature is missing its trusted timestamp', 'TIMESTAMP_MISSING']
])
function failed(category, index, error) {
  failures++
  // Error.message can contain the complete /f + /p command, and stdout/stderr are untrusted. Log only
  // fixed categories and numeric exit statuses, never paths, configuration values or raw child data.
  const status = Number.isSafeInteger(error?.status) ? ` (exit ${error.status})` : ''
  console.error(`[sign-win] ${category} — artifact ${index + 1}${status}`)
}

for (const [index, exe] of targets.entries()) {
  try {
    execFileSync(
      signtool,
      ['sign', '/f', CERT, '/p', PASS, '/fd', 'SHA256', '/tr', TS, '/td', 'SHA256', '/d', 'Métis', exe],
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }
    )
  } catch (error) {
    failed('SIGN_COMMAND_FAILED', index, error)
    continue
  }

  // Use the same absolute system-tool path, literal quoting, exact signer and trusted timestamp
  // policy as the release verifier. A successful signtool invocation alone is not a verified artifact.
  let output
  try {
    output = execFileSync(
      windowsPowerShell(),
      ['-NoProfile', '-NonInteractive', '-Command', windowsSignatureCommand(exe)],
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }
    )
  } catch (error) {
    failed('VERIFY_COMMAND_FAILED', index, error)
    continue
  }
  let signature
  try {
    signature = JSON.parse(output.trim())
  } catch {
    failed('VERIFY_OUTPUT_INVALID', index)
    continue
  }
  const problem = windowsSignatureProblem(signature, EXPECTED_SIGNER)
  if (problem) {
    // The shared policy's detailed message can contain a child-supplied Status; do not echo it here.
    failed(policyFailureCategories.get(problem) || 'SIGNATURE_INVALID', index)
  } else {
    console.log(`[sign-win] artifact ${index + 1}: expected publisher and timestamp verified`)
  }
}

if (failures) {
  console.error(`\n[sign-win] FAIL — ${failures} artifact(s) not validly signed`)
  process.exit(1)
}
console.log(`\n[sign-win] PASS — ${targets.length} artifact(s) Authenticode-signed + verified.`)
