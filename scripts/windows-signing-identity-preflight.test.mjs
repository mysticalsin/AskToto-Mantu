import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { windowsPowerShell } from './lib/signing-policy.mjs'
import {
  evaluateIdentityReport,
  runSigningIdentityPreflight,
  checkTrustedRevision
} from './windows-signing-identity-preflight.mjs'

const SHA = '1'.repeat(40)
const NOW = Date.UTC(2026, 8, 12)
// Deliberately synthetic, not a certificate or private key.
const CERT = Buffer.from('synthetic-pkcs12-fixture').toString('base64')
const PASSWORD = 'synthetic-password-never-log'
const SUBJECT = 'synthetic-publisher-never-log'
const RAW = `${CERT} ${PASSWORD} ${SUBJECT} https://private.invalid/never-log`
const env = () => ({
  GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REPOSITORY: 'mysticalsin/AskToto-Mantu', GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: SHA, METIS_PREFLIGHT_EXPECTED_SHA: SHA,
  WIN_CSC_LINK: CERT, WIN_CSC_KEY_PASSWORD: PASSWORD, WIN_CSC_EXPECTED_SUBJECT: SUBJECT,
  SystemRoot: 'C:\\Windows', TEMP: 'C:\\Temp', NODE_OPTIONS: RAW, GH_TOKEN: RAW,
  PSModulePath: RAW, HTTP_PROXY: RAW
})
const facts = () => ({
  version: 1, privateKeyCount: 1, subjectMatches: true,
  notBeforeMs: NOW - 60_000, notAfterMs: NOW + 60_000,
  codeSigningEku: true, digitalSignatureUsage: true, privateKeyAvailable: true,
  chain: 'trusted'
})
const ok = (value = facts()) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' })
const git = () => `${SHA}\n`
function run(options = {}) {
  return runSigningIdentityPreflight({ env: env(), platform: 'win32', now: NOW,
    revisionCommand: git, probe: () => ok(), ...options })
}
function privateResult(result) {
  const output = JSON.stringify(result)
  for (const secret of [CERT, PASSWORD, SUBJECT, RAW, 'https://private.invalid']) {
    assert.equal(output.includes(secret), false)
  }
}

test('accepts only a complete current, matching, explicitly code-signing trusted identity', () => {
  assert.equal(evaluateIdentityReport(facts(), NOW), 'PASS')
  assert.deepEqual(run(), { ok: true, code: 'PASS', revision: SHA })
})

for (const host of ['darwin', 'linux']) {
  test(`fails on ${host} before either subprocess`, () => {
    const forbidden = () => { assert.fail('must not execute') }
    const result = run({ platform: host, probe: forbidden, revisionCommand: forbidden })
    assert.equal(result.code, 'UNSUPPORTED_PLATFORM')
    assert.equal(result.ok, false)
  })
}

for (const [key, value] of [
  ['GITHUB_ACTIONS', 'false'], ['GITHUB_EVENT_NAME', 'pull_request'],
  ['GITHUB_REPOSITORY', 'elsewhere/fork'], ['GITHUB_REF', 'refs/heads/feature'],
  ['METIS_PREFLIGHT_EXPECTED_SHA', '2'.repeat(40)], ['GITHUB_SHA', RAW]
]) {
  test(`rejects untrusted revision context ${key}`, () => {
    const result = run({ env: { ...env(), [key]: value }, probe: () => assert.fail('must not load credential') })
    assert.equal(result.code, 'REVISION_REJECTED')
    assert.equal(result.ok, false)
    privateResult(result)
  })
}

test('compares actual checkout SHA, without executing a shell or exposing git errors', () => {
  assert.equal(run({ revisionCommand: () => '2'.repeat(40) }).code, 'REVISION_REJECTED')
  const result = run({ revisionCommand: () => { throw new Error(RAW) } })
  assert.equal(result.code, 'REVISION_UNAVAILABLE')
  privateResult(result)
  let called = false
  const checked = checkTrustedRevision(env(), (command, args, options) => {
    called = true
    assert.equal(command, 'git')
    assert.deepEqual(args, ['rev-parse', '--verify', 'HEAD'])
    assert.equal(options.timeout, 10_000)
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe'])
    for (const key of ['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'WIN_CSC_EXPECTED_SUBJECT', 'GH_TOKEN']) {
      assert.equal(options.env[key], undefined)
    }
    return SHA
  })
  assert.equal(called, true)
  assert.equal(checked.code, 'REVISION_ACCEPTED')
})

for (const key of ['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'WIN_CSC_EXPECTED_SUBJECT']) {
  test(`requires ${key} without echoing its value`, () => {
    const result = run({ env: { ...env(), [key]: ' ' }, probe: () => assert.fail('must not execute') })
    assert.equal(result.code, 'CERTIFICATE_CONFIG_MISSING')
    privateResult(result)
  })
}

for (const value of ['https://private.invalid/cert', 'file:///private.pfx', 'C:\\secret\\cert.pfx',
  './cert.pfx', '~/cert.pfx', 'data:application/x-pkcs12;base64,AAAA', '%%%notbase64', 'YWJ', 'A'.repeat(65_537)]) {
  test('unsupported/malformed/oversized credential formats do not fetch or load anything', () => {
    const result = run({ env: { ...env(), WIN_CSC_LINK: value }, probe: () => assert.fail('must not execute') })
    assert.equal(result.code, 'CREDENTIAL_FORMAT_UNSUPPORTED')
    assert.equal(JSON.stringify(result).includes(value), false)
  })
}

test('only passes secrets in a small child environment and bounds runtime and captured output', () => {
  const result = run({ probe: (command, args, options) => {
    assert.equal(command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-File'])
    assert.equal(args.length, 4)
    assert.equal(args[3], fileURLToPath(new URL('./windows-signing-identity-preflight.ps1', import.meta.url)))
    assert.equal(options.timeout, 60_000)
    assert.equal(options.maxBuffer, 4_096)
    assert.equal(options.killSignal, 'SIGKILL')
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe'])
    assert.equal(options.shell, false)
    assert.equal(options.windowsHide, true)
    assert.equal(options.env.WIN_CSC_LINK, CERT)
    assert.equal(options.env.WIN_CSC_KEY_PASSWORD, PASSWORD)
    assert.equal(options.env.WIN_CSC_EXPECTED_SUBJECT, SUBJECT)
    for (const key of ['GH_TOKEN', 'NODE_OPTIONS', 'PSModulePath', 'HTTP_PROXY']) assert.equal(options.env[key], undefined)
    assert.equal(JSON.stringify(args).includes(CERT), false)
    assert.equal(JSON.stringify(args).includes(PASSWORD), false)
    return ok()
  } })
  assert.equal(result.ok, true)
  privateResult(result)
})

for (const [name, override, expected] of [
  ['no private identity', { privateKeyCount: 0 }, 'PRIVATE_KEY_MISSING'],
  ['two private identities', { privateKeyCount: 2 }, 'PRIVATE_KEY_AMBIGUOUS'],
  ['invalid identity count', { privateKeyCount: -1 }, 'PROBE_OUTPUT_INVALID'],
  ['subject mismatch', { subjectMatches: false }, 'PUBLISHER_MISMATCH'],
  ['subject nonboolean', { subjectMatches: 'true' }, 'PROBE_OUTPUT_INVALID'],
  ['invalid timestamp', { notBeforeMs: null }, 'CERTIFICATE_TIME_INVALID'],
  ['inverted timestamps', { notBeforeMs: NOW + 1, notAfterMs: NOW - 1 }, 'CERTIFICATE_TIME_INVALID'],
  ['not yet valid', { notBeforeMs: NOW + 1 }, 'CERTIFICATE_NOT_CURRENT'],
  ['expired', { notAfterMs: NOW - 1 }, 'CERTIFICATE_NOT_CURRENT'],
  ['missing code signing EKU', { codeSigningEku: false }, 'CODE_SIGNING_EKU_MISSING'],
  ['wrong key usage', { digitalSignatureUsage: false }, 'KEY_USAGE_INVALID'],
  ['private handle inaccessible', { privateKeyAvailable: false }, 'PRIVATE_KEY_UNAVAILABLE'],
  ['self-signed/untrusted chain', { chain: 'untrusted' }, 'CHAIN_UNTRUSTED'],
  ['revoked', { chain: 'revoked' }, 'CERTIFICATE_REVOKED'],
  ['offline/unknown revocation', { chain: 'revocation-unavailable' }, 'REVOCATION_UNAVAILABLE'],
  ['chain error', { chain: 'error' }, 'CHAIN_CHECK_FAILED'],
  ['unknown chain response', { chain: RAW }, 'PROBE_OUTPUT_INVALID'],
  ['unexpected response fields', { Subject: SUBJECT }, 'PROBE_OUTPUT_INVALID']
]) {
  test(`fails closed for ${name}`, () => {
    const result = run({ probe: () => ok({ ...facts(), ...override }) })
    assert.equal(result.ok, false)
    assert.equal(result.code, expected)
    privateResult(result)
  })
}

for (const [response, expected] of [
  [{ status: 0, stdout: RAW, stderr: '' }, 'PROBE_OUTPUT_INVALID'],
  [{ status: 0, stdout: JSON.stringify(facts()), stderr: RAW }, 'PROBE_OUTPUT_INVALID'],
  [{ status: 0, stdout: ' '.repeat(4097), stderr: '' }, 'PROBE_OUTPUT_INVALID'],
  [{ status: 0, stdout: { secret: RAW }, stderr: '' }, 'PROBE_OUTPUT_INVALID'],
  [{ status: 7, stdout: RAW, stderr: RAW }, 'PROBE_FAILED'],
  [{ error: { code: 'ETIMEDOUT', message: RAW }, stdout: RAW }, 'PREFLIGHT_TIMEOUT'],
  [{ error: { code: 'ENOBUFS', message: RAW }, stdout: RAW }, 'PROBE_OUTPUT_LIMIT'],
  [{ error: { message: RAW }, stdout: RAW }, 'PROBE_EXECUTION_FAILED'],
  [{ status: 1, stdout: '{"failure":"CERTIFICATE_LOAD_FAILED"}', stderr: '' }, 'CERTIFICATE_LOAD_FAILED'],
  [{ status: 1, stdout: JSON.stringify({ failure: RAW }), stderr: '' }, 'PROBE_FAILED'],
  [{ status: 1, stdout: '{"failure":"PASS"}', stderr: '' }, 'PROBE_FAILED']
]) {
  test(`child failures remain secret-safe: ${expected}`, () => {
    const result = run({ probe: () => response })
    assert.equal(result.ok, false)
    assert.equal(result.code, expected)
    privateResult(result)
  })
}

test('a thrown subprocess exception never exposes its message or output', () => {
  const result = run({ probe: () => { throw Object.assign(new Error(RAW), { stdout: RAW, stderr: RAW }) } })
  assert.equal(result.code, 'PROBE_EXECUTION_FAILED')
  privateResult(result)
})

test('Windows PowerShell parses and safely rejects credential-free non-certificate bytes',
  { skip: process.platform !== 'win32' }, () => {
    // This native smoke runs before workflow secrets are provided. It is not a trust/key-usage
    // success fixture: the public synthetic bytes must fail PKCS#12 import with a fixed category.
    const childEnv = Object.fromEntries(['SystemRoot', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA']
      .filter((key) => typeof process.env[key] === 'string').map((key) => [key, process.env[key]]))
    const child = spawnSync(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-File',
      fileURLToPath(new URL('./windows-signing-identity-preflight.ps1', import.meta.url))], {
      env: { ...childEnv, WIN_CSC_LINK: CERT, WIN_CSC_KEY_PASSWORD: PASSWORD, WIN_CSC_EXPECTED_SUBJECT: SUBJECT },
      encoding: 'utf8', timeout: 15_000, maxBuffer: 4096, killSignal: 'SIGKILL', windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'], shell: false
    })
    assert.equal(Boolean(child.error), false, 'native smoke did not complete')
    assert.equal(child.status, 1, 'native smoke must reject non-certificate bytes')
    assert.equal(child.stderr, '', 'native smoke must not emit raw errors')
    assert.equal(child.stdout.trim(), '{"failure":"CERTIFICATE_LOAD_FAILED"}', 'native smoke must emit only the fixed category')
  })

test('native probe requires ephemeral load, ordinal identity and standard fail-closed chain policy', () => {
  const source = readFileSync(new URL('./windows-signing-identity-preflight.ps1', import.meta.url), 'utf8')
  assert.match(source, /X509KeyStorageFlags\]::EphemeralKeySet/)
  assert.match(source, /StringComparison\]::Ordinal/)
  assert.match(source, /X509RevocationMode\]::Online/)
  assert.match(source, /X509RevocationFlag\]::ExcludeRoot/)
  assert.match(source, /X509VerificationFlags\]::NoFlag/)
  assert.match(source, /UrlRetrievalTimeout\s*=\s*\[TimeSpan\]::FromSeconds\(10\)/)
  assert.match(source, /DisableCertificateDownloads\s*=\s*\$true/)
  assert.match(source, /1\.3\.6\.1\.5\.5\.7\.3\.3/)
  assert.match(source, /GetRSAPrivateKey/)
  assert.match(source, /GetECDsaPrivateKey/)
  assert.match(source, /\.Dispose\(\)/)
  assert.match(source, /\[Array\]::Clear\(\$bytes/)
  assert.doesNotMatch(source, /Import-PfxCertificate|X509Store|PersistKeySet|Exportable|\.Export\(|SignData|SignHash|certutil|Set-AuthenticodeSignature|CustomRootTrust|AllowUnknownCertificateAuthority/)
  assert.doesNotMatch(source, /Write-(Error|Warning|Verbose|Debug|Host)|\$_\s*[|.)]|Exception\.Message/)
})

test('workflow is manual, main-only, exact-revision, read-only and has no release/sign/artifact path', () => {
  const workflow = readFileSync(new URL('../.github/workflows/windows-signing-identity-preflight.yml', import.meta.url), 'utf8')
  assert.match(workflow, /^on:\n  workflow_dispatch:/m)
  assert.doesNotMatch(workflow, /^\s+(push|pull_request|pull_request_target|workflow_call|schedule|workflow_run):/m)
  assert.match(workflow, /permissions:\n  contents: read/)
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/)
  assert.match(workflow, /github\.repository == 'mysticalsin\/AskToto-Mantu'/)
  assert.match(workflow, /persist-credentials: false/)
  assert.match(workflow, /ref: main/)
  assert.match(workflow, /expected_sha:/)
  assert.match(workflow, /--check-revision/)
  assert.match(workflow, /node --test scripts\/windows-signing-identity-preflight\.test\.mjs/)
  assert.match(workflow, /uses: actions\/checkout@[0-9a-f]{40}/)
  assert.doesNotMatch(workflow, /contents: write|id-token:|npm (ci|install|run)|upload-artifact|download-artifact|signtool|electron-builder|gh release|certificateStore|Import-Pfx/)
  assert.equal(workflow.split('secrets.WIN_CSC_LINK').length - 1, 1)
  assert.equal(workflow.split('secrets.WIN_CSC_KEY_PASSWORD').length - 1, 1)
  assert.equal(workflow.split('secrets.WIN_CSC_EXPECTED_SUBJECT').length - 1, 1)
  const lastStep = workflow.slice(workflow.lastIndexOf('      - name:'))
  assert.match(lastStep, /secrets.WIN_CSC_LINK/)
  assert.match(lastStep, /run: node scripts\/windows-signing-identity-preflight\.mjs/)
})
