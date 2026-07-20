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
// local / non-admin / air-gapped path. Both produce the same result: validly Authenticode-signed exes.
//
// Usage:
//   WIN_CSC_LINK=path\to\cert.pfx WIN_CSC_KEY_PASSWORD=... node scripts/sign-win.mjs [artifactsDir]
//   (defaults: artifactsDir=release; timestamp=http://timestamp.digicert.com)
// Exits non-zero if any target fails to sign or verify.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, platform } from 'node:os'

if (platform() !== 'win32') {
  console.error('[sign-win] not on Windows — nothing to do')
  process.exit(0)
}

const CERT = process.env.WIN_CSC_LINK
const PASS = process.env.WIN_CSC_KEY_PASSWORD
const TS = process.env.WIN_TIMESTAMP_URL || 'http://timestamp.digicert.com'
const ARTIFACTS = process.argv.slice(2).find((a) => !a.startsWith('--')) || process.env.ASKTOTO_ARTIFACTS_DIR || 'release'

if (!CERT || !existsSync(CERT)) {
  console.error(`[sign-win] WIN_CSC_LINK not set or file missing: ${CERT || '(unset)'}`)
  process.exit(2)
}
if (!PASS) {
  console.error('[sign-win] WIN_CSC_KEY_PASSWORD not set')
  process.exit(2)
}
if (!existsSync(ARTIFACTS)) {
  console.error(`[sign-win] artifacts dir not found: ${ARTIFACTS}`)
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
  console.error('[sign-win] no signtool.exe found (install the Windows SDK, or run one electron-builder --win once to populate its winCodeSign cache).')
  process.exit(2)
}
console.log(`[sign-win] signtool: ${signtool}`)
console.log(`[sign-win] artifacts: ${ARTIFACTS}`)

// Sign only the distributable installers (Setup + Portable). The unpacked app exe inside win-unpacked/
// is not a deliverable; the Portable exe IS the app and the Setup exe is what SmartScreen / electron-
// updater verify.
const targets = walk(ARTIFACTS, (n) => /\.exe$/i.test(n), 1)
if (!targets.length) {
  console.error(`[sign-win] no .exe artifacts in ${ARTIFACTS}`)
  process.exit(2)
}

const fails = []
for (const exe of targets) {
  try {
    execFileSync(
      signtool,
      ['sign', '/f', CERT, '/p', PASS, '/fd', 'SHA256', '/tr', TS, '/td', 'SHA256', '/d', 'AskToto', exe],
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }
    )
    // Positively verify the signature landed (don't trust signtool's exit code alone).
    const status = execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-AuthenticodeSignature '${exe}').Status`],
      { encoding: 'utf8' }
    ).trim()
    if (/^Valid$/i.test(status)) console.log(`  ✓ signed + Valid: ${exe}`)
    else {
      fails.push(`${exe}: post-sign status ${status}`)
      console.error(`  ✗ ${exe}: status ${status}`)
    }
  } catch (e) {
    fails.push(`${exe}: ${e.message}`)
    console.error(`  ✗ sign failed: ${exe}\n${(e.stdout || '') + (e.stderr || '')}`)
  }
}

if (fails.length) {
  console.error(`\n[sign-win] FAIL — ${fails.length} artifact(s) not validly signed`)
  process.exit(1)
}
console.log(`\n[sign-win] PASS — ${targets.length} artifact(s) Authenticode-signed + verified.`)
