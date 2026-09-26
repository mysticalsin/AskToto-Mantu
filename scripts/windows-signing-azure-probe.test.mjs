import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileCanaryAssembly, runAzureSigningProbe } from './windows-signing-azure-probe.mjs'

const SHA = '3'.repeat(40)
const RAW = 'synthetic-secret-never-log https://private.invalid/never-log'
const EXPECTED_SUBJECT = 'MANTU GROUP SA'
const IDENTITY_EKU = '1.3.6.1.4.1.311.97.9.9'
const PUBLIC_TRUST_EKU = '1.3.6.1.4.1.311.97.1.0'
const TEST_PROFILE_EKU = '1.3.6.1.4.1.311.10.3.13'

const manualEnv = () => ({
  GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REPOSITORY: 'mysticalsin/AskToto-Mantu', GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: SHA, METIS_PREFLIGHT_EXPECTED_SHA: SHA,
  WIN_CSC_EXPECTED_SUBJECT: EXPECTED_SUBJECT,
  WIN_AZURE_SIGNING_ENDPOINT: 'https://weu.codesigning.azure.net',
  WIN_AZURE_SIGNING_ACCOUNT: 'metis-signing', WIN_AZURE_CERT_PROFILE: 'metis-public-trust',
  WIN_AZURE_IDENTITY_EKU: IDENTITY_EKU,
  SystemRoot: 'C:\\Windows', TEMP: 'C:\\Temp', NODE_OPTIONS: RAW, GH_TOKEN: RAW
})
const releaseEnv = () => ({
  GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push',
  GITHUB_REPOSITORY: 'mysticalsin/AskToto-Mantu', GITHUB_REF: 'refs/tags/v1.9.7', GITHUB_SHA: SHA,
  WIN_CSC_EXPECTED_SUBJECT: EXPECTED_SUBJECT,
  WIN_AZURE_SIGNING_ENDPOINT: 'https://weu.codesigning.azure.net',
  WIN_AZURE_SIGNING_ACCOUNT: 'metis-signing', WIN_AZURE_CERT_PROFILE: 'metis-public-trust',
  WIN_AZURE_IDENTITY_EKU: IDENTITY_EKU,
  SystemRoot: 'C:\\Windows', TEMP: 'C:\\Temp', NODE_OPTIONS: RAW, GH_TOKEN: RAW
})
const git = () => `${SHA}\n`
// Same fixed JSON shape scripts/lib/signing-policy.mjs's windowsSignatureCommand emits and
// scripts/verify-signing.mjs / scripts/sign-win.mjs already parse.
const validSignature = () => ({
  Status: 'Valid', Subject: `CN=${EXPECTED_SUBJECT}`, CommonName: EXPECTED_SUBJECT,
  TimeStamperSubject: 'CN=Timestamp Authority', EkuOids: [PUBLIC_TRUST_EKU, '1.3.6.1.5.5.7.3.3', IDENTITY_EKU]
})
function verifyOk(signature = validSignature()) {
  return { status: 0, stdout: JSON.stringify(signature), stderr: '' }
}
function baseDeps(overrides = {}) {
  return {
    env: manualEnv(), platform: 'win32', mode: 'manual', revisionCommand: git,
    compile: () => true, exists: () => true, sign: async () => {}, probe: () => verifyOk(),
    tempDir: 'C:\\RunnerTemp', cleanup: true, ...overrides
  }
}
function privateResult(result) {
  const output = JSON.stringify(result)
  for (const secret of [RAW, 'synthetic-secret-never-log', 'https://private.invalid']) {
    assert.equal(output.includes(secret), false)
  }
}

test('accepts a fully valid Public Trust canary signature end to end', async () => {
  const outcome = await runAzureSigningProbe(baseDeps())
  assert.deepEqual(outcome, { ok: true, code: 'PASS', revision: SHA })
})

test('release-gate mode accepts a tag push at HEAD and rejects a dispatch context', async () => {
  const outcome = await runAzureSigningProbe(baseDeps({ env: releaseEnv(), mode: 'release-gate' }))
  assert.deepEqual(outcome, { ok: true, code: 'PASS', revision: SHA })
  const wrongContext = await runAzureSigningProbe(baseDeps({ mode: 'release-gate' }))
  assert.equal(wrongContext.code, 'REVISION_REJECTED')
})

test('manual mode rejects a tag-push context (each mode rejects the other\'s trigger)', async () => {
  const outcome = await runAzureSigningProbe(baseDeps({ env: releaseEnv(), mode: 'manual' }))
  assert.equal(outcome.code, 'REVISION_REJECTED')
})

test('an unrecognized mode is refused before any secret or subprocess is touched', async () => {
  const outcome = await runAzureSigningProbe(baseDeps({
    mode: 'bogus', revisionCommand: () => assert.fail('must not run'),
    compile: () => assert.fail('must not run'), sign: () => assert.fail('must not run')
  }))
  assert.deepEqual(outcome, { ok: false, code: 'ARGUMENTS_UNSUPPORTED', revision: 'unknown' })
})

for (const host of ['darwin', 'linux']) {
  test(`fails on ${host} before any subprocess or credential`, async () => {
    const forbidden = () => assert.fail('must not execute')
    const outcome = await runAzureSigningProbe(baseDeps({ platform: host,
      revisionCommand: forbidden, compile: forbidden, sign: forbidden, probe: forbidden }))
    assert.deepEqual(outcome, { ok: false, code: 'UNSUPPORTED_PLATFORM', revision: 'unknown' })
  })
}

for (const [key, value] of [
  ['GITHUB_ACTIONS', 'false'], ['GITHUB_EVENT_NAME', 'push'], ['GITHUB_EVENT_NAME', 'pull_request'],
  ['GITHUB_REPOSITORY', 'elsewhere/fork'], ['GITHUB_REF', 'refs/heads/feature'],
  ['METIS_PREFLIGHT_EXPECTED_SHA', '2'.repeat(40)], ['GITHUB_SHA', RAW]
]) {
  test(`rejects untrusted manual revision context ${key}`, async () => {
    const outcome = await runAzureSigningProbe(baseDeps({
      env: { ...manualEnv(), [key]: value },
      compile: () => assert.fail('must not build'), sign: () => assert.fail('must not sign')
    }))
    assert.equal(outcome.code, 'REVISION_REJECTED')
    privateResult(outcome)
  })
}

for (const [key, value] of [
  ['GITHUB_EVENT_NAME', 'workflow_dispatch'], ['GITHUB_REPOSITORY', 'elsewhere/fork'],
  ['GITHUB_REF', 'refs/heads/main'], ['GITHUB_REF', 'refs/tags/notv1']
]) {
  test(`release-gate rejects untrusted revision context ${key}`, async () => {
    const outcome = await runAzureSigningProbe(baseDeps({
      env: { ...releaseEnv(), [key]: value }, mode: 'release-gate',
      compile: () => assert.fail('must not build'), sign: () => assert.fail('must not sign')
    }))
    assert.equal(outcome.code, 'REVISION_REJECTED')
  })
}

for (const key of ['WIN_CSC_EXPECTED_SUBJECT', 'WIN_AZURE_SIGNING_ENDPOINT', 'WIN_AZURE_SIGNING_ACCOUNT', 'WIN_AZURE_CERT_PROFILE']) {
  test(`requires ${key} without echoing its value`, async () => {
    const outcome = await runAzureSigningProbe(baseDeps({
      env: { ...manualEnv(), [key]: ' ' },
      compile: () => assert.fail('must not build'), sign: () => assert.fail('must not sign')
    }))
    assert.equal(outcome.code, 'AZURE_CONFIG_INCOMPLETE')
    privateResult(outcome)
  })
}

test('WIN_AZURE_IDENTITY_EKU is optional: its absence alone is not a config failure', async () => {
  const env = manualEnv()
  delete env.WIN_AZURE_IDENTITY_EKU
  const outcome = await runAzureSigningProbe(baseDeps({ env }))
  assert.equal(outcome.code, 'PASS')
})

test('a failed canary build never reaches the signing step', async () => {
  const outcome = await runAzureSigningProbe(baseDeps({ compile: () => false, sign: () => assert.fail('must not sign') }))
  assert.equal(outcome.code, 'CANARY_BUILD_FAILED')
})

test('a compiler exit that reports success but writes no file is still a build failure', async () => {
  const outcome = await runAzureSigningProbe(baseDeps({ compile: () => true, exists: () => false,
    sign: () => assert.fail('must not sign') }))
  assert.equal(outcome.code, 'CANARY_BUILD_FAILED')
})

test('a throwing compiler is treated as a build failure, not an uncaught rejection', async () => {
  const outcome = await runAzureSigningProbe(baseDeps({ compile: () => { throw new Error(RAW) },
    sign: () => assert.fail('must not sign') }))
  assert.equal(outcome.code, 'CANARY_BUILD_FAILED')
  privateResult(outcome)
})

test('confines the canary path to the caller-provided temp directory', async () => {
  let seen
  await runAzureSigningProbe(baseDeps({ compile: (path) => { seen = path; return true } }))
  assert.ok(seen.startsWith('C:\\RunnerTemp'), seen)
})

test('a rejected sign attempt is reported as a fixed failure category, not the raw error', async () => {
  const outcome = await runAzureSigningProbe(baseDeps({ sign: async () => { throw new Error(RAW) } }))
  assert.equal(outcome.code, 'AZURE_SIGN_FAILED')
  privateResult(outcome)
})

test('a sign attempt that never settles is bounded by a fixed timeout, not left hanging', async () => {
  const outcome = await runAzureSigningProbe(baseDeps({ sign: () => new Promise(() => {}), signTimeoutMs: 25 }))
  assert.equal(outcome.code, 'PROBE_TIMEOUT')
})

test('removes the real canary file after the probe, whether signing succeeds or fails', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'metis-azure-canary-'))
  try {
    for (const sign of [async () => {}, async () => { throw new Error('boom') }]) {
      const outcome = await runAzureSigningProbe(baseDeps({
        tempDir: directory, compile: (path) => { writeFileSync(path, ''); return true },
        exists: existsSync, sign, probe: () => verifyOk()
      }))
      assert.equal(['PASS', 'AZURE_SIGN_FAILED'].includes(outcome.code), true)
      assert.deepEqual(readdirSyncOrEmpty(directory), [], `left a file behind for ${outcome.code}`)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

function readdirSyncOrEmpty(directory) {
  try { return readdirSync(directory) } catch { return [] }
}

test('verify step runs the shared signature-verification command against the signed canary path', async () => {
  const outcome = await runAzureSigningProbe(baseDeps({
    tempDir: 'C:\\RunnerTemp', compile: () => true,
    probe: (command, args, options) => {
      assert.equal(command.endsWith('powershell.exe'), true)
      assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command'])
      assert.match(args[3], /Get-AuthenticodeSignature/)
      assert.match(args[3], /C:\\RunnerTemp/)
      assert.equal(options.timeout, 30_000)
      assert.equal(options.maxBuffer, 4_096)
      assert.equal(options.shell, false)
      for (const key of ['GH_TOKEN', 'NODE_OPTIONS']) assert.equal(options.env[key], undefined)
      return verifyOk()
    }
  }))
  assert.equal(outcome.code, 'PASS')
})

for (const [response, expected] of [
  [{ status: 0, stdout: RAW, stderr: '' }, 'PROBE_OUTPUT_INVALID'],
  [{ status: 0, stdout: JSON.stringify(validSignature()), stderr: RAW }, 'PROBE_EXECUTION_FAILED'],
  [{ status: 0, stdout: ' '.repeat(4097), stderr: '' }, 'PROBE_EXECUTION_FAILED'],
  [{ status: 7, stdout: RAW, stderr: RAW }, 'PROBE_EXECUTION_FAILED'],
  [{ error: { code: 'ETIMEDOUT', message: RAW }, stdout: RAW }, 'PROBE_TIMEOUT'],
  [{ error: { code: 'ENOBUFS', message: RAW }, stdout: RAW }, 'PROBE_OUTPUT_LIMIT'],
  [{ error: { message: RAW }, stdout: RAW }, 'PROBE_EXECUTION_FAILED']
]) {
  test(`verify subprocess failures remain secret-safe: ${expected}`, async () => {
    const outcome = await runAzureSigningProbe(baseDeps({ probe: () => response }))
    assert.equal(outcome.code, expected)
    privateResult(outcome)
  })
}

test('a thrown verify subprocess exception never exposes its message or output', async () => {
  const outcome = await runAzureSigningProbe(baseDeps({
    probe: () => { throw Object.assign(new Error(RAW), { stdout: RAW, stderr: RAW }) }
  }))
  assert.equal(outcome.code, 'PROBE_EXECUTION_FAILED')
  privateResult(outcome)
})

// Integration-level: proves this probe correctly WIRES scripts/lib/signing-policy.mjs's shared azure
// EKU policy into its own fixed output codes. The policy's own edge cases (OID matching semantics,
// malformed-EKU handling, etc.) are exercised directly in verify-signing's own test suite.
for (const [name, override, expected] of [
  ['invalid status', { Status: 'NotTrusted' }, 'AUTHENTICODE_NotTrusted'],
  ['publisher mismatch', { CommonName: 'Someone Else', Subject: 'CN=Someone Else' }, 'PUBLISHER_MISMATCH'],
  ['missing timestamp', { TimeStamperSubject: '' }, 'TIMESTAMP_MISSING'],
  ['missing EKU list entirely', { EkuOids: undefined }, 'PUBLIC_TRUST_EKU_MISSING'],
  ['missing Public Trust EKU', { EkuOids: ['1.3.6.1.5.5.7.3.3'] }, 'PUBLIC_TRUST_EKU_MISSING'],
  ['test-profile lifetime EKU present', { EkuOids: [PUBLIC_TRUST_EKU, TEST_PROFILE_EKU] }, 'TEST_PROFILE_EKU_PRESENT'],
  ['identity EKU mismatch', { EkuOids: [PUBLIC_TRUST_EKU] }, 'IDENTITY_EKU_MISMATCH']
]) {
  test(`classifies ${name} through the full pipeline`, async () => {
    const outcome = await runAzureSigningProbe(baseDeps({ probe: () => verifyOk({ ...validSignature(), ...override }) }))
    assert.equal(outcome.code, expected)
    privateResult(outcome)
  })
}

test('compileCanaryAssembly confines the compile command to the requested path via Windows PowerShell', () => {
  let seen
  const ok = compileCanaryAssembly('C:\\Runner\'s Temp\\canary.dll', (command, args) => {
    seen = { command, args }
    return { status: 0, error: undefined }
  })
  assert.equal(ok, true)
  assert.equal(seen.command.endsWith('powershell.exe'), true)
  assert.match(seen.args[3], /Add-Type -OutputType Library -OutputAssembly 'C:\\Runner''s Temp\\canary\.dll'/)
  assert.match(seen.args[3], /MetisSigningCanary/)
})

test('compileCanaryAssembly reports failure on a nonzero exit or a spawn error', () => {
  assert.equal(compileCanaryAssembly('C:\\t\\c.dll', () => ({ status: 1 })), false)
  assert.equal(compileCanaryAssembly('C:\\t\\c.dll', () => ({ status: 0, error: new Error('spawn failed') })), false)
})

function assertManualWorkflowContract(source) {
  const workflow = source.replace(/\r\n/g, '\n')
  assert.match(workflow, /^on:\n  workflow_dispatch:/m)
  assert.doesNotMatch(workflow, /^\s+(push|pull_request|pull_request_target|workflow_call|schedule|workflow_run):/m)
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/)
  assert.match(workflow, /github\.repository == 'mysticalsin\/AskToto-Mantu'/)
  assert.match(workflow, /environment:\s*windows-signing/)
  assert.match(workflow, /permissions:\n {2}contents: read\n {2}id-token: write/)
  assert.match(workflow, /uses: actions\/checkout@[0-9a-f]{40}/)
  assert.match(workflow, /uses: azure\/login@7184910d9eb2b1c5e48f7073824a90609bb9b6d6/)
  assert.match(workflow, /expected_sha:/)
  assert.match(workflow, /--check-revision/)
  assert.match(workflow, /node scripts\/artifact-signing-module\.mjs install/)
  assert.match(workflow, /node scripts\/windows-signing-azure-probe\.mjs\s*$/m)
  assert.doesNotMatch(workflow, /WIN_CSC_LINK|WIN_CSC_KEY_PASSWORD/)
  assert.doesNotMatch(workflow, /npm (ci|install|run)|electron-builder|gh release|download-artifact|contents: write/)
}

const manualWorkflowSource = readFileSync(new URL('../.github/workflows/windows-signing-azure-preflight.yml', import.meta.url), 'utf8')

test('the manual azure preflight workflow matches its security contract', () => {
  assertManualWorkflowContract(manualWorkflowSource)
})

for (const [name, lineEnding] of [['LF', '\n'], ['CRLF', '\r\n']]) {
  test(`accepts the manual azure preflight contract with ${name} line endings`, () => {
    assertManualWorkflowContract(manualWorkflowSource.replace(/\r?\n/g, lineEnding))
  })
}

test('the manual azure preflight CLI mode is wired and exits non-zero off a non-Windows host', () => {
  const script = fileURLToPath(new URL('./windows-signing-azure-probe.mjs', import.meta.url))
  const child = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 10_000 })
  assert.equal(child.status, 1)
  assert.deepEqual(JSON.parse(child.stdout.trim()), { ok: false, code: 'UNSUPPORTED_PLATFORM', revision: 'unknown' })
})

test('the --release-gate CLI mode is wired and exits non-zero off a non-Windows host', () => {
  const script = fileURLToPath(new URL('./windows-signing-azure-probe.mjs', import.meta.url))
  const child = spawnSync(process.execPath, [script, '--release-gate'], { encoding: 'utf8', timeout: 10_000 })
  assert.equal(child.status, 1)
  assert.deepEqual(JSON.parse(child.stdout.trim()), { ok: false, code: 'UNSUPPORTED_PLATFORM', revision: 'unknown' })
})

for (const argv of [['extra'], ['--Release-Gate'], ['--release-gate', 'extra']]) {
  test(`unsupported CLI argv forms remain rejected: ${JSON.stringify(argv)}`, () => {
    const script = fileURLToPath(new URL('./windows-signing-azure-probe.mjs', import.meta.url))
    const child = spawnSync(process.execPath, [script, ...argv], { encoding: 'utf8', timeout: 10_000 })
    assert.equal(child.status, 1)
    assert.deepEqual(JSON.parse(child.stdout.trim()), { ok: false, code: 'ARGUMENTS_UNSUPPORTED', revision: 'unknown' })
  })
}
