#!/usr/bin/env node
// Manual identity diagnostics only. Never signs an app, publishes, or writes a certificate file.
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { windowsPowerShell } from './lib/signing-policy.mjs'

const SHA = /^[0-9a-f]{40}$/
const MAX_CREDENTIAL_CHARACTERS = 65_536
const MAX_PROBE_BYTES = 4_096
const PROBE_TIMEOUT_MS = 60_000
const REPORT_KEYS = ['version', 'privateKeyCount', 'subjectMatches', 'notBeforeMs', 'notAfterMs',
  'codeSigningEku', 'digitalSignatureUsage', 'privateKeyAvailable', 'chain']
const NATIVE_FAILURES = new Set(['CERTIFICATE_LOAD_FAILED', 'PROBE_INTERNAL_FAILED'])

function selectedEnvironment(env, names) {
  return Object.fromEntries(names.filter((name) => typeof env[name] === 'string').map((name) => [name, env[name]]))
}

function result(code, revision = 'unknown') {
  return { ok: code === 'PASS' || code === 'REVISION_ACCEPTED', code, revision }
}

export function checkTrustedRevision(env = process.env, revisionCommand = execFileSync) {
  const revision = SHA.test(env.GITHUB_SHA || '') ? env.GITHUB_SHA : 'unknown'
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
      env.GITHUB_REPOSITORY !== 'mysticalsin/AskToto-Mantu' || env.GITHUB_REF !== 'refs/heads/main' ||
      revision === 'unknown' || env.METIS_PREFLIGHT_EXPECTED_SHA !== revision) {
    return result('REVISION_REJECTED', revision)
  }
  try {
    const actual = revisionCommand('git', ['rev-parse', '--verify', 'HEAD'], {
      encoding: 'utf8', timeout: 10_000, maxBuffer: 1_024, killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false,
      // In the final step the parent already has the secrets: git must not inherit them.
      env: selectedEnvironment(env, ['PATH', 'Path', 'SystemRoot', 'windir', 'HOME', 'USERPROFILE', 'TEMP', 'TMP'])
    })
    return result(String(actual).trim() === revision ? 'REVISION_ACCEPTED' : 'REVISION_REJECTED', revision)
  } catch {
    return result('REVISION_UNAVAILABLE', revision)
  }
}

export function evaluateIdentityReport(report, now = Date.now()) {
  if (!report || typeof report !== 'object' || Array.isArray(report) ||
      Object.keys(report).length !== REPORT_KEYS.length || REPORT_KEYS.some((key) => !Object.hasOwn(report, key)) ||
      report.version !== 1 || !Number.isSafeInteger(report.privateKeyCount) || report.privateKeyCount < 0 ||
      ['subjectMatches', 'codeSigningEku', 'digitalSignatureUsage', 'privateKeyAvailable']
        .some((key) => typeof report[key] !== 'boolean') ||
      !['trusted', 'untrusted', 'revoked', 'revocation-unavailable', 'error'].includes(report.chain)) {
    return 'PROBE_OUTPUT_INVALID'
  }
  if (report.privateKeyCount === 0) return 'PRIVATE_KEY_MISSING'
  if (report.privateKeyCount !== 1) return 'PRIVATE_KEY_AMBIGUOUS'
  if (!report.subjectMatches) return 'PUBLISHER_MISMATCH'
  if (![report.notBeforeMs, report.notAfterMs, now].every(Number.isSafeInteger) ||
      report.notBeforeMs >= report.notAfterMs) return 'CERTIFICATE_TIME_INVALID'
  if (now < report.notBeforeMs || now > report.notAfterMs) return 'CERTIFICATE_NOT_CURRENT'
  if (!report.codeSigningEku) return 'CODE_SIGNING_EKU_MISSING'
  if (!report.digitalSignatureUsage) return 'KEY_USAGE_INVALID'
  if (!report.privateKeyAvailable) return 'PRIVATE_KEY_UNAVAILABLE'
  return ({ trusted: 'PASS', untrusted: 'CHAIN_UNTRUSTED', revoked: 'CERTIFICATE_REVOKED',
    'revocation-unavailable': 'REVOCATION_UNAVAILABLE', error: 'CHAIN_CHECK_FAILED' })[report.chain]
}

function supportedCredential(value) {
  // Same raw base64 PKCS#12 input supported by electron-builder, but deliberately not its URL/path
  // forms. A preflight must not fetch a secret URL or silently materialize a private identity.
  if (typeof value !== 'string' || value.length > MAX_CREDENTIAL_CHARACTERS) return false
  const compact = value.replace(/[\r\n\t ]/g, '')
  return compact.length > 0 && compact.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)
}

export function runSigningIdentityPreflight({ env = process.env, platform = process.platform,
  now, revisionCommand = execFileSync, probe = spawnSync } = {}) {
  if (platform !== 'win32') return result('UNSUPPORTED_PLATFORM')
  const revision = checkTrustedRevision(env, revisionCommand)
  if (!revision.ok) return revision
  const fail = (code) => result(code, revision.revision)
  if (['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'WIN_CSC_EXPECTED_SUBJECT']
    .some((key) => typeof env[key] !== 'string' || !env[key].trim())) return fail('CERTIFICATE_CONFIG_MISSING')
  if (!supportedCredential(env.WIN_CSC_LINK)) return fail('CREDENTIAL_FORMAT_UNSUPPORTED')

  let child
  try {
    child = probe(windowsPowerShell(env), ['-NoProfile', '-NonInteractive', '-File',
      fileURLToPath(new URL('./windows-signing-identity-preflight.ps1', import.meta.url))], {
      encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, maxBuffer: MAX_PROBE_BYTES,
      killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false,
      env: selectedEnvironment(env, ['SystemRoot', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA',
        'APPDATA', 'ProgramData', 'ALLUSERSPROFILE', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'WIN_CSC_EXPECTED_SUBJECT'])
    })
  } catch {
    return fail('PROBE_EXECUTION_FAILED')
  }
  // Never include raw exceptions, stdout/stderr, command arguments or configuration in the result.
  if (child?.error) return fail(child.error.code === 'ETIMEDOUT' ? 'PREFLIGHT_TIMEOUT' :
    child.error.code === 'ENOBUFS' ? 'PROBE_OUTPUT_LIMIT' : 'PROBE_EXECUTION_FAILED')
  const text = typeof child?.stdout === 'string' ? child.stdout.trim() : ''
  const bounded = typeof child?.stdout === 'string' && Buffer.byteLength(child.stdout) <= MAX_PROBE_BYTES
  if (child?.status !== 0) {
    if (child?.status === 1 && bounded && !child.stderr) {
      try {
        const failure = JSON.parse(text)
        if (Object.keys(failure).length === 1 && NATIVE_FAILURES.has(failure.failure)) return fail(failure.failure)
      } catch { /* Deliberately suppress malformed or secret-bearing native output. */ }
    }
    return fail('PROBE_FAILED')
  }
  if (!bounded || child.stderr || !text) return fail('PROBE_OUTPUT_INVALID')
  try {
    return fail(evaluateIdentityReport(JSON.parse(text), now ?? Date.now()))
  } catch {
    return fail('PROBE_OUTPUT_INVALID')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let outcome
  if (process.argv.length === 3 && process.argv[2] === '--check-revision') outcome = checkTrustedRevision()
  else if (process.argv.length === 2) outcome = runSigningIdentityPreflight()
  else outcome = result('ARGUMENTS_UNSUPPORTED')
  console.log(JSON.stringify(outcome))
  process.exitCode = outcome.ok ? 0 : 1
}
