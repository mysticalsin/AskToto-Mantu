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
  version: 2, privateKeyCount: 1, subjectMatches: true,
  notBeforeMs: NOW - 60_000, notAfterMs: NOW + 60_000,
  codeSigningEku: true, digitalSignatureUsage: true, privateKeyAvailable: true,
  chain: 'trusted', chainStatusFlags: []
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

// Version 2 reports carry numeric enum flags, never certificate/chain text.
const diagnosticFacts = (override = {}) => ({ ...facts(), ...override })

test('MQA-330 reconstructs sorted unique codes from combined numeric chain flags', () => {
  const flags = [0x10020, 0x20, 0x10000]
  const result = run({ probe: () => ok(diagnosticFacts({ chain: 'untrusted', chainStatusFlags: flags })) })
  assert.deepEqual(result, { ok: false, code: 'CHAIN_UNTRUSTED', revision: SHA,
    chainStatusCodes: ['PartialChain', 'UntrustedRoot'] })
  assert.deepEqual(flags, [0x10020, 0x20, 0x10000], 'decoding must not mutate the source flags')
  privateResult(result)
})

const publicChainFlags = [
  [1, 'NotTimeValid'], [2, 'NotTimeNested'], [4, 'Revoked'], [8, 'NotSignatureValid'],
  [16, 'NotValidForUsage'], [32, 'UntrustedRoot'], [64, 'RevocationStatusUnknown'], [128, 'Cyclic'],
  [256, 'InvalidExtension'], [512, 'InvalidPolicyConstraints'], [1024, 'InvalidBasicConstraints'],
  [2048, 'InvalidNameConstraints'], [4096, 'HasNotSupportedNameConstraint'],
  [8192, 'HasNotDefinedNameConstraint'], [16384, 'HasNotPermittedNameConstraint'],
  [32768, 'HasExcludedNameConstraint'], [65536, 'PartialChain'], [131072, 'CtlNotTimeValid'],
  [262144, 'CtlNotSignatureValid'], [524288, 'CtlNotValidForUsage'], [1048576, 'HasWeakSignature'],
  [16777216, 'OfflineRevocation'], [33554432, 'NoIssuanceChainPolicy'],
  [67108864, 'ExplicitDistrust'], [134217728, 'HasNotSupportedCriticalExtension']
]

for (const [flag, name] of publicChainFlags) {
  test(`MQA-330 emits the fixed public enum name ${name} without changing failure`, () => {
    const chain = flag === 4 ? 'revoked' : [64, 16777216].includes(flag) ? 'revocation-unavailable' : 'untrusted'
    const code = flag === 4 ? 'CERTIFICATE_REVOKED' : [64, 16777216].includes(flag) ? 'REVOCATION_UNAVAILABLE' : 'CHAIN_UNTRUSTED'
    const result = run({ probe: () => ok(diagnosticFacts({ chain, chainStatusFlags: [flag] })) })
    assert.equal(result.ok, false)
    assert.equal(result.code, code)
    assert.deepEqual(result.chainStatusCodes, [name])
    privateResult(result)
  })
}

for (const flags of [[0x200000], [0x80000000], [0x80000020, 0x20, 0x200000]]) {
  test('MQA-330 reduces any unknown bits to a fixed sentinel, preserving known flags', () => {
    const result = run({ probe: () => ok(diagnosticFacts({ chain: 'untrusted', chainStatusFlags: flags })) })
    assert.equal(result.code, 'CHAIN_UNTRUSTED')
    assert.equal(result.ok, false)
    assert.deepEqual(result.chainStatusCodes, flags.some((flag) => (flag & 0x20) !== 0)
      ? ['UNKNOWN_CHAIN_STATUS', 'UntrustedRoot'] : ['UNKNOWN_CHAIN_STATUS'])
    privateResult(result)
  })
}

test('MQA-330 bounds maximum diagnostic output even for every uint32 bit and 32 entries', () => {
  const result = run({ probe: () => ok(diagnosticFacts({ chain: 'revoked',
    chainStatusFlags: Array(32).fill(0xffffffff) })) })
  assert.equal(result.code, 'CERTIFICATE_REVOKED')
  assert.equal(result.ok, false)
  assert.deepEqual(result.chainStatusCodes, [...publicChainFlags.map(([, name]) => name), 'UNKNOWN_CHAIN_STATUS'].sort())
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 1024)
})

for (const [chain, code, flags, expected] of [
  ['untrusted', 'CHAIN_UNTRUSTED', [], ['NO_REPORTED_CHAIN_STATUS']],
  ['untrusted', 'CHAIN_UNTRUSTED', [0], ['NO_REPORTED_CHAIN_STATUS']],
  ['revoked', 'CERTIFICATE_REVOKED', [0x24], ['Revoked', 'UntrustedRoot']],
  ['revocation-unavailable', 'REVOCATION_UNAVAILABLE', [0x1010040], ['OfflineRevocation', 'PartialChain', 'RevocationStatusUnknown']],
  ['error', 'CHAIN_CHECK_FAILED', [], ['NO_REPORTED_CHAIN_STATUS']]
]) {
  test(`MQA-330 preserves ${code} and distinguishes absence of reported status`, () => {
    const result = run({ probe: () => ok(diagnosticFacts({ chain, chainStatusFlags: flags })) })
    assert.deepEqual(result, { ok: false, code, revision: SHA, chainStatusCodes: expected })
    privateResult(result)
  })
}

test('MQA-330 retains the success contract only for an unflagged version 2 trusted report', () => {
  assert.deepEqual(run({ probe: () => ok(diagnosticFacts()) }), { ok: true, code: 'PASS', revision: SHA })
})

for (const flags of [[0], [32], [0x80000000], [4, 64]]) {
  test('MQA-330 rejects a contradictory trusted report with reported flags', () => {
    const result = run({ probe: () => ok(diagnosticFacts({ chainStatusFlags: flags })) })
    assert.deepEqual(result, { ok: false, code: 'PROBE_OUTPUT_INVALID', revision: SHA })
  })
}

for (const [chain, flags] of [
  ['revoked', []], ['revoked', [0]], ['revoked', [32]], ['revoked', [64]],
  ['revoked', [0x1000000]], ['revoked', [0x80000000]],
  ['revocation-unavailable', []], ['revocation-unavailable', [0]],
  ['revocation-unavailable', [32]], ['revocation-unavailable', [4]],
  ['revocation-unavailable', [0x44]], ['revocation-unavailable', [0x1000004]],
  ['revocation-unavailable', [0x80000000]],
  ['untrusted', [4]], ['untrusted', [64]], ['untrusted', [0x1000000]], ['untrusted', [0x80000044]]
]) {
  test(`MQA-330 rejects a contradictory failure category ${chain}`, () => {
    const result = run({ probe: () => ok(diagnosticFacts({ chain, chainStatusFlags: flags })) })
    assert.deepEqual(result, { ok: false, code: 'PROBE_OUTPUT_INVALID', revision: SHA })
    privateResult(result)
  })
}

for (const [chain, code, flags, expected] of [
  ['revoked', 'CERTIFICATE_REVOKED', [0x44], ['RevocationStatusUnknown', 'Revoked']],
  ['revoked', 'CERTIFICATE_REVOKED', [0x1000004], ['OfflineRevocation', 'Revoked']],
  ['revoked', 'CERTIFICATE_REVOKED', [4, 64, 0x1000000, 0x80000000],
    ['OfflineRevocation', 'RevocationStatusUnknown', 'Revoked', 'UNKNOWN_CHAIN_STATUS']],
  ['revocation-unavailable', 'REVOCATION_UNAVAILABLE', [64], ['RevocationStatusUnknown']],
  ['revocation-unavailable', 'REVOCATION_UNAVAILABLE', [0x1000000], ['OfflineRevocation']],
  ['revocation-unavailable', 'REVOCATION_UNAVAILABLE', [0x1000040, 32],
    ['OfflineRevocation', 'RevocationStatusUnknown', 'UntrustedRoot']],
  ['error', 'CHAIN_CHECK_FAILED', [0], ['NO_REPORTED_CHAIN_STATUS']],
  ['error', 'CHAIN_CHECK_FAILED', [0x24], ['Revoked', 'UntrustedRoot']],
  ['error', 'CHAIN_CHECK_FAILED', [64], ['RevocationStatusUnknown']]
]) {
  test(`MQA-330 preserves valid native category precedence and ${chain} error reports`, () => {
    const result = run({ probe: () => ok(diagnosticFacts({ chain, chainStatusFlags: flags })) })
    assert.deepEqual(result, { ok: false, code, revision: SHA, chainStatusCodes: expected })
    privateResult(result)
  })
}

for (const flags of [undefined, null, RAW, {}, [RAW], [-1], [0.5], [0x100000000],
  [Number.MAX_SAFE_INTEGER + 1], [null], [true], Array(33).fill(32)]) {
  test('MQA-330 rejects missing, malformed or oversized failure diagnostics without echoing them', () => {
    const result = run({ probe: () => ok(diagnosticFacts({ chain: 'untrusted', chainStatusFlags: flags })) })
    assert.deepEqual(result, { ok: false, code: 'PROBE_OUTPUT_INVALID', revision: SHA })
    privateResult(result)
  })
}

for (const report of [
  Object.fromEntries(Object.entries({ ...facts(), version: 1 }).filter(([key]) => key !== 'chainStatusFlags')),
  diagnosticFacts({ version: undefined }), diagnosticFacts({ version: 1 }),
  diagnosticFacts({ version: 3 }), diagnosticFacts({ version: '2' }),
  diagnosticFacts({ chain: 'untrusted', chainStatusFlags: [32], StatusInformation: RAW }),
  diagnosticFacts({ chain: 'untrusted', chainStatusFlags: [32], Issuer: RAW }),
  diagnosticFacts({ chain: 'untrusted', chainStatusFlags: [32], chainStatusCodes: [RAW] })
]) {
  test('MQA-330 rejects stale/missing protocol or extra native text fields without disclosure', () => {
    const result = run({ probe: () => ok(report) })
    assert.deepEqual(result, { ok: false, code: 'PROBE_OUTPUT_INVALID', revision: SHA })
    privateResult(result)
  })
}

test('MQA-330 does not attach chain diagnostics when an earlier identity check fails', () => {
  const result = run({ probe: () => ok(diagnosticFacts({ subjectMatches: false, chain: 'untrusted', chainStatusFlags: [] })) })
  assert.deepEqual(result, { ok: false, code: 'PUBLISHER_MISMATCH', revision: SHA })
})

test('MQA-330 native report uses only bounded numeric Status flags and the version 2 contract', () => {
  const source = readFileSync(new URL('./windows-signing-identity-preflight.ps1', import.meta.url), 'utf8')
  assert.match(source, /version\s*=\s*2;/)
  assert.match(source, /chainStatusFlags\s*=\s*@\(\)/)
  assert.match(source, /\$statuses\.Length\s*-gt\s*32/)
  assert.match(source, /\[long\]\$status\.Status\s*-band\s*\[long\]4294967295/)
  assert.doesNotMatch(source, /StatusInformation|\$status\.ToString\(|\$status\.Status\.ToString\(/)
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
  ['untrusted chain', { chain: 'untrusted' }, 'CHAIN_UNTRUSTED'],
  ['revoked', { chain: 'revoked', chainStatusFlags: [4] }, 'CERTIFICATE_REVOKED'],
  ['offline/unknown revocation', { chain: 'revocation-unavailable', chainStatusFlags: [64] }, 'REVOCATION_UNAVAILABLE'],
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

function assertWorkflowContract(source) {
  const workflow = source.replace(/\r\n/g, '\n')
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
}

const workflowSource = readFileSync(new URL('../.github/workflows/windows-signing-identity-preflight.yml', import.meta.url), 'utf8')

test('workflow is manual, main-only, exact-revision, read-only and has no release/sign/artifact path', () => {
  assertWorkflowContract(workflowSource)
})

for (const [name, lineEnding] of [['LF', '\n'], ['CRLF', '\r\n']]) {
  const workflow = workflowSource.replace(/\r?\n/g, lineEnding)

  test(`MQA-328 accepts the complete workflow security contract with ${name} line endings`, () => {
    assertWorkflowContract(workflow)
  })

  const unsafeChanges = [
    ['an automatic trigger', workflow.replace('permissions:', `  push:${lineEnding}${lineEnding}permissions:`),
      /^\s+(push|pull_request|pull_request_target|workflow_call|schedule|workflow_run):/m],
    ['write permissions', workflow.replace('contents: read', 'contents: write'), /permissions:\n  contents: read/],
    ['a different main-branch gate', workflow.replace('refs/heads/main', 'refs/heads/feature'), /github\.ref == 'refs\/heads\/main'/],
    ['a missing revision check', workflow.replace('--check-revision', '--no-revision-check'), /--check-revision/]
  ]

  for (const [change, changedWorkflow, expectedGate] of unsafeChanges) {
    test(`MQA-328 rejects ${change} under ${name} at the intended security gate`, () => {
      assert.notEqual(changedWorkflow, workflow, 'negative fixture must change the workflow')
      assert.throws(() => assertWorkflowContract(changedWorkflow), (error) =>
        error.code === 'ERR_ASSERTION' && String(error.expected) === String(expectedGate))
    })
  }
}
