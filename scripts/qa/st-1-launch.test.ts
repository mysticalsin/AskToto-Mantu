import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import {
  mkdirSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPackage } from '@electron/asar'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  candidateLaunchPlan,
  launchIsolationReport,
  buildLaunchFailureReport,
  buildReport,
  emptyRun
} from './lib/st-1-core.mjs'
import {
  BROKER_PROBE_OUTPUT,
  observeCanary,
  observeSecurityBrokers,
  readPackagedName,
  requireBrokerDenial,
  trackCandidateSpawn,
  trackInspectorConnection,
  validateRestrictedExecutable,
  verifyCandidate
} from './lib/st-1-launch.mjs'

const dirs: string[] = []
function temporary() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'st1-launch-test-')))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('fixed Security broker denial evidence [M2-0538]', () => {
  const success = { status: 0, signal: null, stdout: BROKER_PROBE_OUTPUT, stderr: '' }
  it('accepts only exact complete real-denial output and a clean successful process exit', () => {
    expect(() => requireBrokerDenial(success)).not.toThrow()
  })
  it.each([
    { status: 1 },
    { status: 124 },
    { status: null, signal: 'SIGTERM' },
    { status: null, signal: 'SIGALRM' },
    { error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) },
    { error: Object.assign(new Error('missing executable'), { code: 'ENOENT' }) },
    { stdout: '' },
    { stdout: BROKER_PROBE_OUTPUT + '\n' },
    { stdout: BROKER_PROBE_OUTPUT.replace('1100', '1102') },
    { stdout: BROKER_PROBE_OUTPUT.replace('1100', '0') },
    { stdout: BROKER_PROBE_OUTPUT.replace('1100 0', '1100 1') },
    { stderr: 'unexpected diagnostic' }
  ])('fails closed on error, timeout, signal or malformed evidence %j', (change) => {
    expect(() => requireBrokerDenial({ ...success, ...change })).toThrow('denial not established')
  })
  it('pins canonical probe bytes and the strict profile before an empty-environment execution', () => {
    const env = canaryEnv()
    const control = join(env.OWNER_SANDBOX_TEMP, 'broker-control.fixture')
    mkdirSync(control)
    const probe = join(control, 'check-security-brokers')
    writeFileSync(probe, 'synthetic never-executed probe')
    const digest = createHash('sha256').update(readFileSync(probe)).digest('hex')
    const workspace = temporary()
    const profile = join(workspace, 'scripts', 'hermetic', 'owner-runner.sb')
    mkdirSync(join(workspace, 'scripts', 'hermetic'), { recursive: true })
    writeFileSync(profile, 'synthetic profile')
    const profileDigest = createHash('sha256').update(readFileSync(profile)).digest('hex')
    const config = {
      ...env,
      OWNER_QA_CONTROL_DIR: control,
      QA_CHECK_PATH: probe,
      QA_CHECK_SHA256: digest,
      GITHUB_WORKSPACE: workspace,
      OWNER_SANDBOX_PROFILE_SHA256: profileDigest,
      DYLD_INSERT_LIBRARIES: 'must-not-reach-the-probe',
      BASH_ENV: 'must-not-reach-the-probe'
    }
    const execute = vi.fn(() => success)
    const call = () => observeSecurityBrokers(config, execute as unknown as typeof spawnSync)
    expect(call()).toEqual({
      lookupStatus: 1100,
      services: 11,
      profileSha256: profileDigest,
      probeSha256: digest,
      namedServiceAbsence: 'not-observed'
    })
    expect(execute).toHaveBeenCalledWith(probe, [], expect.objectContaining({ env: {}, timeout: 12_000 }))
    execute.mockClear()
    config.QA_CHECK_SHA256 = '0'.repeat(64)
    expect(call).toThrow('digest mismatch')
    expect(execute).not.toHaveBeenCalled()
    config.QA_CHECK_SHA256 = digest
    config.OWNER_SANDBOX_PROFILE_SHA256 = '0'.repeat(64)
    expect(call).toThrow('profile digest mismatch')
    expect(execute).not.toHaveBeenCalled()
    config.OWNER_SANDBOX_PROFILE_SHA256 = profileDigest
    const alias = join(workspace, 'hard-alias')
    linkSync(probe, alias)
    expect(call).toThrow('identity or digest mismatch')
    expect(execute).not.toHaveBeenCalled()
    rmSync(alias)
    const outside = join(workspace, 'outside-probe')
    writeFileSync(outside, readFileSync(probe))
    rmSync(probe)
    symlinkSync(outside, probe, 'file')
    expect(call).toThrow('identity or digest mismatch')
    expect(execute).not.toHaveBeenCalled()
  })
})
const candidate = { variant: 'mac-qa-identity', artifact_sha256: 'a'.repeat(64), build_run_id: 1 }
const owner = {
  ST1_USE_MOCK_KEYCHAIN: '1',
  ST1_CHROMIUM_SANDBOX: 'off',
  GITHUB_ACTIONS: 'true',
  ASKTOTO_LOCAL_KEYSTORE: '1',
  GITHUB_JOB: 'st1-mac-fifo',
  RUNNER_ENVIRONMENT: 'self-hosted',
  OWNER_SANDBOX_ROUTE: 'owner',
  OWNER_SANDBOX_ENTERED: '1',
  OWNER_SANDBOX_ENTERED_PROFILE: 'owner-runner.sb'
}
const plan = (env: Record<string, string | undefined> = owner, overrides = {}) =>
  candidateLaunchPlan({ env, platform: 'darwin', usesExe: false, candidate, ...overrides })
const permission = () => {
  throw Object.assign(new Error('denied'), { code: 'EPERM' })
}
const deniedIO = { readFileSync: permission, openSync: permission, closeSync: () => undefined }
function canaryEnv() {
  const root = temporary()
  const job = join(root, 'metis-owner-1-1-st1-mac-fifo')
  const temp = join(job, 'invocation.fixture')
  mkdirSync(temp, { recursive: true })
  return {
    RUNNER_TEMP: root,
    GITHUB_RUN_ID: '1',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_JOB: 'st1-mac-fifo',
    OWNER_SANDBOX_JOB_ROOT: job,
    OWNER_SANDBOX_TEMP: temp,
    OWNER_SANDBOX_CANARY: join(temp, '.sandbox-canary')
  }
}

describe('ST-1 restricted launch admission [M2-0538]', () => {
  it.each(['darwin', 'linux', 'win32'])('keeps the exact default arguments on %s', (platform) => {
    expect(plan({}, { platform }).argv).toEqual(['--inspect=127.0.0.1:0'])
  })
  it('admits the combined flags only on the explicit wrapped owner route', () => {
    const actual = plan()
    expect(actual.argv).toEqual(['--inspect=127.0.0.1:0', '--use-mock-keychain', '--no-sandbox'])
    expect(Object.isFrozen(actual)).toBe(true)
    expect(Object.isFrozen(actual.argv)).toBe(true)
    expect(actual.wrapperReportedProfile).toBe('owner-runner.sb')
    expect(plan({ ...owner, ST1_CHROMIUM_SANDBOX: 'on' }).argv).not.toContain('--no-sandbox')
  })
  it.each([
    { ST1_USE_MOCK_KEYCHAIN: 'true' },
    { ST1_USE_MOCK_KEYCHAIN: '' },
    { ST1_CHROMIUM_SANDBOX: 'false' },
    { ST1_CHROMIUM_SANDBOX: '' },
    { ST1_USE_MOCK_KEYCHAIN: '0' },
    { OWNER_SANDBOX_ROUTE: 'hosted-fixture' },
    { OWNER_SANDBOX_ENTERED: undefined },
    { OWNER_SANDBOX_ENTERED_PROFILE: 'owner-account.sb' },
    { GITHUB_JOB: 'other-job' },
    { GITHUB_ACTIONS: 'false' },
    { RUNNER_ENVIRONMENT: 'github-hosted' },
    { ASKTOTO_LOCAL_KEYSTORE: undefined },
    { ASKTOTO_LOCAL_KEYSTORE: '0' }
  ])('refuses malformed or unauthorized configuration %j', (change) => {
    expect(() => plan({ ...owner, ...change })).toThrow()
  })
  it.each([
    { platform: 'win32' },
    { platform: 'linux' },
    { usesExe: true },
    { candidate: { ...candidate, variant: 'mac' } },
    { candidate: { ...candidate, artifact_sha256: '' } }
  ])('refuses the wrong platform, executable or identity %j', (change) => {
    expect(() => plan(owner, change)).toThrow()
  })
  it('requires both actual permission denials, not a missing file or marker alone', () => {
    const env = canaryEnv()
    expect(observeCanary(env, deniedIO)).toEqual({ readDenied: true, writeDenied: true })
    expect(() => observeCanary(env)).toThrow('permission denial')
    expect(() => observeCanary(env, { ...deniedIO, readFileSync: () => Buffer.from('readable') })).toThrow(
      'permission denial'
    )
    expect(() => observeCanary(env, { ...deniedIO, openSync: () => 1 })).toThrow('permission denial')
    expect(() => observeCanary(env, { ...deniedIO, openSync: () => 1, closeSync: permission })).toThrow('denied')
    expect(() => observeCanary({ ...env, RUNNER_TEMP: undefined }, deniedIO)).toThrow('canonical')
    expect(() =>
      observeCanary({ ...env, OWNER_SANDBOX_CANARY: join(env.OWNER_SANDBOX_TEMP, 'other') }, deniedIO)
    ).toThrow('configuration')
    expect(() => observeCanary({ ...env, OWNER_SANDBOX_JOB_ROOT: temporary() }, deniedIO)).toThrow('canonical')
    const alias = join(env.OWNER_SANDBOX_JOB_ROOT, 'invocation.alias')
    symlinkSync(env.OWNER_SANDBOX_TEMP, alias, 'junction')
    expect(() =>
      observeCanary(
        { ...env, OWNER_SANDBOX_TEMP: alias, OWNER_SANDBOX_CANARY: join(alias, '.sandbox-canary') },
        deniedIO
      )
    ).toThrow('canonical')
  })
  it('retains the uniquely matched build variant and refuses duplicate or mismatched provenance', async () => {
    const root = temporary()
    const installer = join(root, 'candidate.zip')
    const provenance = join(root, 'provenance.json')
    writeFileSync(installer, 'synthetic bytes')
    const sha256 = createHash('sha256').update('synthetic bytes').digest('hex')
    const build = { variant: 'mac-qa-identity', assets: [{ name: 'candidate.zip', sha256 }] }
    const write = (builds: unknown[]) => writeFileSync(provenance, JSON.stringify({ run: { id: 1 }, builds }))
    write([build])
    await expect(verifyCandidate(installer, provenance)).resolves.toEqual({
      ...candidate,
      artifact_sha256: sha256
    })
    write([build, build])
    await expect(verifyCandidate(installer, provenance)).rejects.toThrow('expected one')
    write([{ ...build, assets: [{ name: 'candidate.zip', sha256: '0'.repeat(64) }] }])
    await expect(verifyCandidate(installer, provenance)).rejects.toThrow('sha256 mismatch')
  })
})

async function packaged(name = 'asktoto-qa') {
  const root = temporary()
  const app = join(root, 'Metis QA.app')
  const resources = join(app, 'Contents', 'Resources')
  const exe = join(app, 'Contents', 'MacOS', 'Metis QA')
  const source = join(root, 'source')
  mkdirSync(resources, { recursive: true })
  mkdirSync(join(app, 'Contents', 'MacOS'))
  mkdirSync(source)
  writeFileSync(exe, 'never executed')
  writeFileSync(join(app, 'Contents', 'Info.plist'), 'fixture identity reader')
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name }))
  const archive = join(resources, 'app.asar')
  await createPackage(source, archive)
  return { root, app, exe, archive }
}

describe('packaged identity before restricted launch [M2-0538]', () => {
  it('reads a real ASAR-generated package and verifies the contained QA executable and both identities', async () => {
    const fixture = await packaged()
    expect(readPackagedName(fixture.archive)).toBe('asktoto-qa')
    const env = canaryEnv()
    const args = {
      plan: plan(),
      env,
      exe: fixture.exe,
      unzipDir: fixture.root,
      readBundleId: () => 'com.mantu.asktoto.qa',
      canaryIO: deniedIO
    }
    expect(validateRestrictedExecutable(args)).toEqual({
      canary: { readDenied: true, writeDenied: true },
      identity: { bundleId: 'com.mantu.asktoto.qa', packageName: 'asktoto-qa' }
    })
    expect(() => validateRestrictedExecutable({ ...args, readBundleId: () => 'com.mantu.asktoto' })).toThrow(
      'identity mismatch'
    )
    expect(() => validateRestrictedExecutable({ ...args, unzipDir: null })).toThrow('fresh extracted ZIP')
    const outside = join(temporary(), 'outside')
    writeFileSync(outside, 'never executed')
    expect(() => validateRestrictedExecutable({ ...args, exe: outside })).toThrow('escapes')
  })
  it('rejects a shipping package name even if the bundle ID claims QA', async () => {
    const fixture = await packaged('asktoto')
    expect(() =>
      validateRestrictedExecutable({
        plan: plan(),
        env: {},
        exe: fixture.exe,
        unzipDir: fixture.root,
        readBundleId: () => 'com.mantu.asktoto.qa'
      })
    ).toThrow('identity mismatch')
  })
  it('uses the effective JSON identity rather than an earlier misleading duplicate name', async () => {
    const fixture = await packaged()
    const source = join(fixture.root, 'source')
    writeFileSync(join(source, 'package.json'), '{"name":"asktoto-qa","name":"asktoto"}')
    await createPackage(source, fixture.archive)
    expect(readPackagedName(fixture.archive)).toBe('asktoto')
    expect(() =>
      validateRestrictedExecutable({
        plan: plan(),
        env: {},
        exe: fixture.exe,
        unzipDir: fixture.root,
        readBundleId: () => 'com.mantu.asktoto.qa'
      })
    ).toThrow('identity mismatch')
  })
  it('rejects truncated, overlarge and malformed ASAR headers without allocating their declared size', async () => {
    const fixture = await packaged()
    const original = readFileSync(fixture.archive)
    truncateSync(fixture.archive, original.length - 2)
    expect(() => readPackagedName(fixture.archive)).toThrow('truncated')
    const oversized = Buffer.from(original)
    oversized.writeUInt32LE(0xffffffff, 4)
    writeFileSync(fixture.archive, oversized)
    expect(() => readPackagedName(fixture.archive)).toThrow('invalid ASAR header')
    writeFileSync(fixture.archive, Buffer.alloc(5))
    expect(() => readPackagedName(fixture.archive)).toThrow('truncated')
  })
  it.each([
    { link: 'elsewhere' },
    { unpacked: true },
    { offset: '-1' },
    { offset: '9007199254740992' },
    { offset: '1e6' },
    { size: 2 * 1024 * 1024 },
    { files: {} }
  ])('rejects non-packed or unsafe package metadata %j', async (change) => {
    const fixture = await packaged()
    const original = readFileSync(fixture.archive)
    const oldHeaderSize = original.readUInt32LE(4)
    const header = JSON.parse(original.subarray(16, 16 + original.readUInt32LE(12)).toString())
    Object.assign(header.files['package.json'], change)
    const json = Buffer.from(JSON.stringify(header))
    const padding = Buffer.alloc((4 - (json.length % 4)) % 4)
    const prefix = Buffer.alloc(16)
    prefix.writeUInt32LE(4, 0)
    prefix.writeUInt32LE(8 + json.length + padding.length, 4)
    prefix.writeUInt32LE(4 + json.length + padding.length, 8)
    prefix.writeUInt32LE(json.length, 12)
    writeFileSync(fixture.archive, Buffer.concat([prefix, json, padding, original.subarray(8 + oldHeaderSize)]))
    expect(() => readPackagedName(fixture.archive)).toThrow()
  })
})

describe('isolation report lifecycle [M2-0538]', () => {
  it('observes real child/socket events, not object creation, inspector advertisement or failure events', () => {
    const state = { processSpawned: false, inspectorConnected: false }
    const child = new EventEmitter()
    child.on('error', () => undefined)
    trackCandidateSpawn(child, state)
    const socket = new EventTarget()
    trackInspectorConnection(socket, state)
    child.emit('stderr', 'Debugger listening on ws://127.0.0.1:1234/fixture')
    child.emit('error', new Error('spawn refused'))
    socket.dispatchEvent(new Event('error'))
    expect(state).toEqual({ processSpawned: false, inspectorConnected: false })
    child.emit('spawn')
    expect(state).toEqual({ processSpawned: true, inspectorConnected: false })
    socket.dispatchEvent(new Event('open'))
    expect(state).toEqual({ processSpawned: true, inspectorConnected: true })
  })
  it('never equates configuration, spawn attempt or advertised inspector with successful execution', () => {
    const requested = Object.freeze({ mockKeychain: '1', chromiumSandbox: 'off' })
    const state = { spawnAttempted: false, processSpawned: false, inspectorConnected: false }
    const planned = plan()
    expect(launchIsolationReport(planned, state, requested)).toMatchObject({
      admittedArguments: ['--inspect=127.0.0.1:0', '--use-mock-keychain', '--no-sandbox'],
      configuredStorage: { localKeystore: true, mockKeychain: true, initialization: 'not-observed' }
    })
    expect(launchIsolationReport(null, state, requested)).toMatchObject({
      admitted: false,
      chromiumSandboxDisabledAtSpawn: false
    })
    state.spawnAttempted = true
    expect(launchIsolationReport(planned, state, requested)).toMatchObject({
      processSpawned: false,
      chromiumSandboxDisabledAtSpawn: false
    })
    state.processSpawned = true
    expect(launchIsolationReport(planned, state, requested)).toMatchObject({
      chromiumSandboxDisabledAtSpawn: true,
      inspectorConnected: false
    })
    state.inspectorConnected = true
    expect(launchIsolationReport(planned, state, requested).inspectorConnected).toBe(true)
  })
  it('passes the same captured evidence into both report factories without rereading environment', () => {
    const identity = Object.freeze({ bundleId: 'com.mantu.asktoto.qa', packageName: 'asktoto-qa' })
    const isolation = launchIsolationReport(plan(), { identity }, { mockKeychain: '1', chromiumSandbox: 'off' })
    expect(isolation.identity).toBe(identity)
    const common = { row: 'none', installer: 'fixture.zip', candidate, fixtures: [], isolation }
    expect(buildLaunchFailureReport({ ...common, reason: 'prelaunch failure' }).isolation).toBe(isolation)
    expect(
      buildReport({
        ...common,
        minutes: 1,
        measured: emptyRun(),
        evidence: {},
        attribution: {},
        complete: false,
        harnessError: null
      }).isolation
    ).toBe(isolation)
  })
})
