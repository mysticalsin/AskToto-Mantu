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
// Windows: Get-AuthenticodeSignature on the .exe (Status Valid and subject/CN exactly matches the
// required WIN_CSC_EXPECTED_SUBJECT release input; no legal certificate identity is guessed in code).
// A platform can only verify its own artifacts, so on macOS the Windows .exe check is skipped (noted),
// and vice-versa. Exits non-zero on a genuine signature failure.

import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { platform } from 'node:os'
import {
  assertSigningHost,
  selectSigningDirectory,
  windowsSignatureCommand,
  windowsSignatureProblem,
  windowsPowerShell
} from './lib/signing-policy.mjs'

const ALLOW_ADHOC_MAC = String(process.env.ASKTOTO_ALLOW_ADHOC_MAC || '').trim() === '1'
const REQUIRE_NOTARIZED = process.argv.includes('--require-notarized') && !ALLOW_ADHOC_MAC
if (process.argv.includes('--require-notarized') && ALLOW_ADHOC_MAC) {
  console.log('[verify:signing] ASKTOTO_ALLOW_ADHOC_MAC=1 — skipping notarization gate (ADHOC / not Gatekeeper-notarized)')
}
const argDir = process.argv.slice(2).find((a) => !a.startsWith('--'))
const { directory: dir, candidates } = selectSigningDirectory(argDir)
function sh(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const stdout = result.stdout || ''
  const stderr = result.stderr || ''
  const error = result.error?.message || ''
  return {
    ok: result.status === 0 && !result.error,
    stdout,
    stderr,
    // codesign/spctl write their successful diagnostics to stderr; always retain both streams.
    out: [stdout, stderr, error].filter(Boolean).join('\n')
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
if (!dir) {
  console.error('[verify:signing] No artifacts dir found. Build first, or pass a path / set ASKTOTO_ARTIFACTS_DIR.')
  console.error('  looked in: ' + candidates.join(', '))
  process.exit(2)
}
try { assertSigningHost(platform()) } catch (error) {
  console.error(`[verify:signing] ${error.message}`)
  process.exit(2)
}
console.log(`[verify:signing] artifacts dir: ${dir}`)

// ── macOS ────────────────────────────────────────────────────────────────────
const apps = walk(dir, (n, s) => n.endsWith('.app') && s.isDirectory(), 3)
const dmgs = walk(dir, (n) => n.endsWith('.dmg'), 2)
if (platform() === 'darwin') {
  if (!apps.length) fails.push('no .app found to verify on this macOS run')
  for (const app of apps) {
    const v = sh('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
    if (v.ok) console.log(`  ✓ codesign valid: ${app}`)
    else { fails.push(`codesign FAILED: ${app}\n${v.out.trim()}`); console.error(`  ✗ codesign FAILED: ${app}`) }
    const id = sh('codesign', ['-dvv', app])
    const auth = (id.out.match(/Authority=(.+)/) || [])[1]
    if (auth) console.log(`    identity: ${auth}`)
    const gate = sh('spctl', ['-a', '-vvv', '-t', 'exec', app])
    const accepted = gate.ok
    if (accepted) console.log('    Gatekeeper: accepted (Developer ID + notarized)')
    else {
      const detail = gate.out.trim() ? `\n${gate.out.trim()}` : ''
      const msg = `    Gatekeeper: NOT accepted (dev-signed / not notarized) - ${app}${detail}`
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
  const expectedSigner = String(process.env.WIN_CSC_EXPECTED_SUBJECT || '').trim()
  if (!expectedSigner) {
    fails.push('WIN_CSC_EXPECTED_SUBJECT is required and must exactly match the release certificate subject or common name')
  }
  const exes = walk(dir, (n) => n.endsWith('.exe'), 2)
  if (!exes.length) fails.push('no .exe found to verify on this Windows run')
  for (const exe of exes) {
    const command = windowsSignatureCommand(exe)
    const r = sh(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-Command', command])
    let signature = {}
    try {
      signature = JSON.parse(r.stdout.trim())
    } catch {
      // The status check below reports the command/output as a signing failure.
    }
    const subject = String(signature.Subject || '').trim()
    const commonName = String(signature.CommonName || '').trim()
    const problem = !r.ok ? 'Authenticode verification command failed' : windowsSignatureProblem(signature, expectedSigner)
    if (problem) {
      fails.push(`${problem}: ${exe}`)
      console.error(`  ✗ ${problem}: ${exe}`)
      if (r.out.trim()) console.error(`    ${r.out.trim()}`)
    } else {
      console.log(`  ✓ Authenticode Valid: ${exe}`)
      console.log(`    identity: ${subject} (CN=${commonName})`)
      console.log(`    timestamp: ${signature.TimeStamperSubject}`)
    }
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
