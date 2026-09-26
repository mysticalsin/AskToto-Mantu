#!/usr/bin/env node
// Fail-closed release secret gate. electron-builder can otherwise keep building
// after a missing signing identity, which is fine for CI smoke artifacts but not
// for a tagged release or store package.

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveWindowsSigningMode, describeSigningModeFailure } from './lib/windows-signing-mode.mjs'

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

const APPLE_RELEASE_SECRETS = ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']

switch (mode) {
  case 'mac':
    requireAny(['GH_TOKEN', 'GITHUB_TOKEN'], 'GitHub release token')
    requireAll(APPLE_RELEASE_SECRETS, 'macOS Developer ID release')
    break
  case 'win': {
    // Thin CLI over the shared pfx/azure resolver: one source of truth, reused as-is by
    // scripts/electron-builder-win.mjs to build the signing config overlay. Never prints an env
    // value, only the fixed failure code and the names of the variables it names.
    const resolved = resolveWindowsSigningMode(process.env)
    if (!resolved.ok) fail(describeSigningModeFailure(resolved))
    else console.log(`[check:release-secrets] OK - win (${resolved.mode})`)
    break
  }
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
// 'win' already printed its own richer OK line above (with the resolved mode).
if (mode !== 'win') console.log(`[check:release-secrets] OK - ${mode}`)
