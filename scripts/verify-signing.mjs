#!/usr/bin/env node
// Post-build signature gate for AskToto. Positively VERIFIES the produced app/installer is validly
// signed, instead of trusting electron-builder's exit code — a non-fatal signing slip, an expired
// cert, or a lost notarization ticket otherwise ships a build Gatekeeper/SmartScreen rejects on launch
// (a dead app for every user, invisible until the wild).
//
// Dependency-free; shells out to the platform's own tools. Run AFTER a build, before any upload:
//   node scripts/verify-signing.mjs [artifactsDir]     (or set ASKTOTO_ARTIFACTS_DIR)
//   node scripts/verify-signing.mjs --require-notarized   (also FAIL if not Gatekeeper-accepted)
//
// macOS: codesign --verify --deep --strict on the .app; spctl assessment (notarization).
// Windows: Get-AuthenticodeSignature on the .exe (Status must be Valid).
// A platform can only verify its own artifacts, so on macOS the Windows .exe check is skipped (noted),
// and vice-versa. Exits non-zero on a genuine signature failure.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, platform } from 'node:os'

const REQUIRE_NOTARIZED = process.argv.includes('--require-notarized')
const argDir = process.argv.slice(2).find((a) => !a.startsWith('--'))
const CANDIDATE_DIRS = [
  argDir,
  process.env.ASKTOTO_ARTIFACTS_DIR,
  join(homedir(), 'AI-Brain-build', 'asktoto-release'),
  'release',
  'dist',
].filter(Boolean)

function findDir() {
  for (const d of CANDIDATE_DIRS) if (existsSync(d)) return d
  return null
}
function sh(cmd, args) {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || '') + (e.message || '') }
  }
}
function walk(dir, test, depth = 4) {
  const hits = []
  const rec = (d, lvl) => {
    if (lvl < 0) return
    let entries = []
    try { entries = readdirSync(d) } catch { return }
    for (const name of entries) {
      const p = join(d, name)
      let s
      try { s = statSync(p) } catch { continue }
      if (test(name, s, p)) hits.push(p)
      if (s.isDirectory() && !name.endsWith('.app')) rec(p, lvl - 1)
    }
  }
  rec(dir, depth)
  return hits
}

const fails = []
const notes = []
const dir = findDir()
if (!dir) {
  console.error('[verify:signing] No artifacts dir found. Build first, or pass a path / set ASKTOTO_ARTIFACTS_DIR.')
  console.error('  looked in: ' + CANDIDATE_DIRS.join(', '))
  process.exit(2)
}
console.log(`[verify:signing] artifacts dir: ${dir}`)

// ── macOS ────────────────────────────────────────────────────────────────────
const apps = walk(dir, (n, s) => n.endsWith('.app') && s.isDirectory(), 3)
const dmgs = walk(dir, (n) => n.endsWith('.dmg'), 2)
if (platform() === 'darwin') {
  if (!apps.length && !dmgs.length) notes.push('no .app/.dmg found to verify on this macOS run')
  for (const app of apps) {
    const v = sh('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
    if (v.ok) console.log(`  ✓ codesign valid: ${app}`)
    else { fails.push(`codesign FAILED: ${app}\n${v.out.trim()}`); console.error(`  ✗ codesign FAILED: ${app}`) }
    const id = sh('codesign', ['-dvv', app])
    const auth = (id.out.match(/Authority=(.+)/) || [])[1]
    if (auth) console.log(`    identity: ${auth}`)
    const gate = sh('spctl', ['-a', '-vvv', '-t', 'exec', app])
    const accepted = /accepted/i.test(gate.out)
    if (accepted) console.log('    Gatekeeper: accepted (Developer ID + notarized)')
    else {
      const msg = `    Gatekeeper: NOT accepted (dev-signed / not notarized) - ${app}`
      if (REQUIRE_NOTARIZED) { fails.push(msg.trim()); console.error('  ✗' + msg) }
      else { notes.push(msg.trim()); console.log('    Gatekeeper: not notarized (ok for a local/dev build; use --require-notarized for release gating)') }
    }
  }
  for (const dmg of dmgs) {
    const v = sh('codesign', ['--verify', '--verbose=2', dmg])
    if (v.ok) console.log(`  ✓ codesign valid (dmg): ${dmg}`)
    else notes.push(`dmg not codesigned (electron-builder signs the .app inside, not always the dmg): ${dmg}`)
  }
  const exes = walk(dir, (n) => n.endsWith('.exe'), 2)
  if (exes.length) notes.push(`skipped ${exes.length} Windows .exe (Authenticode can only be checked on Windows)`)
}

// ── Windows ──────────────────────────────────────────────────────────────────
if (platform() === 'win32') {
  const exes = walk(dir, (n) => n.endsWith('.exe'), 2)
  if (!exes.length) notes.push('no .exe found to verify on this Windows run')
  for (const exe of exes) {
    const r = sh('powershell', ['-NoProfile', '-Command', `(Get-AuthenticodeSignature '${exe}').Status`])
    const status = (r.out || '').trim()
    if (/^Valid$/i.test(status)) console.log(`  ✓ Authenticode Valid: ${exe}`)
    else { fails.push(`Authenticode ${status || 'UNSIGNED'}: ${exe}`); console.error(`  ✗ Authenticode ${status || 'UNSIGNED'}: ${exe}`) }
  }
  if (apps.length || dmgs.length) notes.push('skipped macOS artifacts (codesign can only be checked on macOS)')
}

if (notes.length) { console.log('\nnotes:'); for (const n of notes) console.log('  · ' + n) }
if (fails.length) {
  console.error(`\n[verify:signing] FAIL — ${fails.length} signature problem(s):`)
  for (const f of fails) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log('\n[verify:signing] PASS — all inspected artifacts are validly signed.')
