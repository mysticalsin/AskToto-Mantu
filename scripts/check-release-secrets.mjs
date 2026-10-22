#!/usr/bin/env node
// Fail-closed release secret gate. electron-builder can otherwise keep building
// after a missing signing identity, which is fine for CI smoke artifacts but not
// for a tagged release or store package.

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { ENROLL_TOKEN_RE, enrollRequired } from './lib/operator-enroll-embed.mjs'

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

// Zero-config Operator reporting: a release build embeds an enrolment token (scripts/embed-operator-enroll-token.mjs).
// Until the production token exists the gate only warns, and the build enrols through SSO only. Setting
// METIS_OPERATOR_ENROLL_REQUIRED=1 makes a missing or malformed token fail closed. The token is never printed.
function checkOperatorEnrollToken() {
  const token = value('METIS_OPERATOR_ENROLL_TOKEN')
  if (!token) {
    if (enrollRequired(process.env)) {
      fail('Operator enrolment token missing: METIS_OPERATOR_ENROLL_TOKEN (METIS_OPERATOR_ENROLL_REQUIRED=1)')
    } else {
      console.warn(
        '[check:release-secrets] WARNING - METIS_OPERATOR_ENROLL_TOKEN is not set: this build enrols with Operator through SSO only. ' +
          'Set METIS_OPERATOR_ENROLL_REQUIRED=1 to make a missing token fail the release.'
      )
    }
    return
  }
  if (!ENROLL_TOKEN_RE.test(token)) {
    const message = 'METIS_OPERATOR_ENROLL_TOKEN is not a METIS-ENR-1.<kid>.<secret> token'
    if (enrollRequired(process.env)) fail(message)
    else console.warn(`[check:release-secrets] WARNING - ${message}: the embed step will refuse it.`)
  }
}

const APPLE_RELEASE_SECRETS = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID'
]

switch (mode) {
  case 'mac':
    requireAny(['GH_TOKEN', 'GITHUB_TOKEN'], 'GitHub release token')
    requireAll(APPLE_RELEASE_SECRETS, 'macOS Developer ID release')
    checkOperatorEnrollToken()
    break
  case 'win':
    requireAny(['GH_TOKEN', 'GITHUB_TOKEN'], 'GitHub release token')
    requireAll(['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'WIN_CSC_EXPECTED_SUBJECT'], 'Windows Authenticode release')
    checkOperatorEnrollToken()
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
