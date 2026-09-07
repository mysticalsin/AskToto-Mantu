#!/usr/bin/env node
// Release secret gate. Windows / MAS stay fail-closed. macOS Developer ID +
// notarization is the default; ASKTOTO_ADHOC_SIGN=1 allows the local ad-hoc
// path when CSC_LINK / APPLE_* are absent (not notarized).

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const mode = process.argv[2] || ''

function value(name) {
  return String(process.env[name] || '').trim()
}

function present(name) {
  return value(name).length > 0
}

function fail(message) {
  console.error(`[check:release-secrets] FAIL - ${message}`)
  process.exitCode = 1
}

function requireAll(names, label) {
  const missing = names.filter((name) => !present(name))
  if (missing.length) fail(`${label} missing: ${missing.join(', ')}`)
}

function requireAny(names, label) {
  if (!names.some((name) => present(name))) fail(`${label} missing one of: ${names.join(', ')}`)
}

function requireFileEnv(name, label) {
  if (!present(name)) {
    fail(`${label} missing: ${name}`)
    return
  }
  const p = resolve(value(name))
  if (!existsSync(p)) fail(`${label} file does not exist: ${p}`)
}

switch (mode) {
  case 'mac':
    requireAny(['GH_TOKEN', 'GITHUB_TOKEN'], 'GitHub release token')
    if (!process.exitCode) {
      const macSecrets = ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']
      const missingMac = macSecrets.filter((name) => !present(name))
      if (missingMac.length === 0) {
        console.log('[check:release-secrets] macOS Developer ID + notarization path')
      } else if (value('ASKTOTO_ADHOC_SIGN') === '1') {
        console.log('[check:release-secrets] ADHOC macOS path — not notarized.')
        console.log(`[check:release-secrets] Missing Developer ID / Apple secrets: ${missingMac.join(', ')}`)
      } else {
        fail(`macOS Developer ID release missing: ${missingMac.join(', ')} (set ASKTOTO_ADHOC_SIGN=1 for the ad-hoc path)`)
      }
    }
    break
  case 'win':
    requireAny(['GH_TOKEN', 'GITHUB_TOKEN'], 'GitHub release token')
    requireAll(
      ['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'WIN_CSC_EXPECTED_SUBJECT'],
      'Windows Authenticode release'
    )
    break
  case 'mas':
    requireAll(['CSC_LINK', 'CSC_KEY_PASSWORD'], 'Mac App Store app signing')
    requireFileEnv('MAS_PROVISIONING_PROFILE', 'Mac App Store provisioning profile')
    break
  case 'win-store':
    // Microsoft Store MSIX/AppX submissions are re-signed by Microsoft after upload.
    // This mode exists so the store script has an explicit preflight slot.
    break
  default:
    console.error('Usage: node scripts/check-release-secrets.mjs <mac|win|mas|win-store>')
    process.exit(2)
}

if (process.exitCode) process.exit(process.exitCode)
console.log(`[check:release-secrets] OK - ${mode}`)
