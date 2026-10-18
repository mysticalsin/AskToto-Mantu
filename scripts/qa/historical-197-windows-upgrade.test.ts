import { describe, expect, it, vi, afterEach } from 'vitest'
import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { lstat, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  assessNativeFiles,
  assessHistoricalUpgradeReport,
  configureAndSeed,
  readInstalledProfile,
  runHistoricalUpgrade,
  REQUIRED_CHECKS,
  validateOwnedStoragePath,
  createWindowsDriver,
  runOwnedInstaller,
  cleanupWindowsOwnership
} from './historical-197-windows-upgrade.mjs'
import { ownedCensus, waitForChildExit, disposeFreshOnboardingTransports, killOwned, launchPackagedCdp } from './lib/app-driver.mjs'
import { listProcesses } from './owned-processes.mjs'

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(), spawnSync: vi.fn(actual.spawnSync) }
})
vi.mock('./lib/app-driver.mjs', async (original) => {
  const actual = await original<typeof import('./lib/app-driver.mjs')>()
  return { ...actual, ownedCensus: vi.fn(actual.ownedCensus), waitForChildExit: vi.fn(actual.waitForChildExit),
    disposeFreshOnboardingTransports: vi.fn(actual.disposeFreshOnboardingTransports), killOwned: vi.fn(),
    launchPackagedCdp: vi.fn(actual.launchPackagedCdp) }
})
vi.mock('./owned-processes.mjs', async (original) => {
  const actual = await original<typeof import('./owned-processes.mjs')>()
  return { ...actual, listProcesses: vi.fn(actual.listProcesses) }
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetAllMocks()
})

const expected = {
  meetingsRoot: 'C:\\owned\\profile\\meetings',
  title: 'Synthetic title',
  line: 'Synthetic transcript canary',
  key: 'sk-synthetic-private-canary',
  startedAt: 1792000000000
}
const settings = () => ({
  version: '1.9.6', meetingsFolder: expected.meetingsRoot, resolvedMeetingsFolder: expected.meetingsRoot,
  allowedProviders: [] as string[], envKeys: [], encryptTranscripts: true, temperature: 0.42, onboardingDone: true,
  hasKeys: { openai: true }, localLlm: { enabled: false }
})
function pageFixture() {
  const toto = {
    authStatus: vi.fn(async () => ({ configured: false, signedIn: false, enforced: false })),
    getSettings: vi.fn(async () => settings()),
    setSettings: vi.fn(async () => settings()),
    setApiKey: vi.fn(async () => ({ hasKeys: { openai: true } })),
    saveTranscript: vi.fn(async () => ({ path: `${expected.meetingsRoot}\\meeting.md` })),
    recallList: vi.fn(async () => [{ file: 'meeting.md', title: expected.title }]),
    recallRead: vi.fn(async () => ({ ok: true, title: expected.title, recap: '', lines: [{ text: expected.line }] }))
  }
  vi.stubGlobal('window', { toto })
  const page = { evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg) }
  return { page, toto }
}
const encrypted = () => ({
  settings: Buffer.from('ATKENC1\nopaque-native-settings'),
  provider: Buffer.from('opaque-native-provider'),
  meeting: Buffer.from(`ATKENC2\n${JSON.stringify({
    v: 2, iv: Buffer.alloc(12, 1).toString('base64'), tag: Buffer.alloc(16, 2).toString('base64'),
    ct: Buffer.from('opaque-content').toString('base64'), kLocal: `S:${Buffer.from('opaque-wrapped-key').toString('base64')}`
  })}`)
})

describe('historical Windows native format controls (synthetic bytes, not DPAPI acceptance)', () => {
  it('validates real owned files and refuses outside paths or junction aliases before reading', async () => {
    const root = await mkdtemp(join(tmpdir(), 'historical-path-'))
    try {
      const owned = join(root, 'owned')
      const outside = join(root, 'outside')
      await mkdir(owned)
      await mkdir(outside)
      await writeFile(join(owned, 'meeting.md'), 'synthetic storage-path fixture')
      await writeFile(join(outside, 'meeting.md'), 'synthetic outside fixture')
      await expect(validateOwnedStoragePath(owned, join(owned, 'meeting.md'), true)).resolves.toBeTruthy()
      await expect(validateOwnedStoragePath(owned, join(outside, 'meeting.md'), true)).rejects.toThrow()
      await symlink(outside, join(owned, 'alias'), 'junction')
      await expect(validateOwnedStoragePath(owned, join(owned, 'alias', 'meeting.md'), true)).rejects.toThrow()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('accepts native markers without demanding a file keystore', () => {
    expect(assessNativeFiles(encrypted(), [expected.key, expected.line, expected.title]).native).toBe(true)
  })
  it.each(['settings', 'provider', 'meeting'] as const)('rejects plaintext canary in %s', (field) => {
    const files = encrypted()
    files[field] = Buffer.concat([files[field], Buffer.from(expected.line)])
    expect(() => assessNativeFiles(files, [expected.line])).toThrow()
  })
  it('rejects file-backend settings, provider keys and F: meeting envelopes', () => {
    expect(() => assessNativeFiles({ ...encrypted(), settings: Buffer.from('ATKENC2\nopaque') }, [])).toThrow()
    expect(() => assessNativeFiles({ ...encrypted(), provider: Buffer.from('ATKAES1\nopaque') }, [])).toThrow()
    const files = encrypted()
    files.meeting = Buffer.from(files.meeting.toString().replace('S:', 'F:'))
    expect(() => assessNativeFiles(files, [])).toThrow()
  })
  it('rejects malformed or empty native envelopes', () => {
    expect(() => assessNativeFiles({ ...encrypted(), meeting: Buffer.from('ATKENC2\n{}') }, [])).toThrow()
  })
})

describe('actual ordinary preload consumer', () => {
  it('binds effective storage before key/transcript writes and uses the shared historical payload', async () => {
    const { page, toto } = pageFixture()
    const admit = vi.fn(async () => {})
    const saved = await configureAndSeed(page, expected, admit)
    expect(saved).toBe(`${expected.meetingsRoot}\\meeting.md`)
    expect(toto.setSettings).toHaveBeenCalledWith(expect.objectContaining({ meetingsFolder: expected.meetingsRoot }))
    expect(toto.setSettings.mock.invocationCallOrder[0]).toBeLessThan(toto.setApiKey.mock.invocationCallOrder[0])
    expect(toto.setApiKey.mock.invocationCallOrder[0]).toBeLessThan(toto.saveTranscript.mock.invocationCallOrder[0])
    expect(admit).toHaveBeenCalledTimes(2)
    expect(admit.mock.invocationCallOrder[0]).toBeLessThan(toto.setApiKey.mock.invocationCallOrder[0])
    expect(admit.mock.invocationCallOrder[1]).toBeLessThan(toto.saveTranscript.mock.invocationCallOrder[0])
    expect(toto.saveTranscript).toHaveBeenCalledWith({
      title: expected.title, mode: 'general', startedAt: expected.startedAt, durationMs: 64000,
      lines: [{ speaker: 'you', text: expected.line, t: expected.startedAt + 2000 }], recap: ''
    })
  })
  it.each(['configured', 'signedIn', 'enforced'] as const)('refuses unexpected auth %s before writes', async (field) => {
    const { page, toto } = pageFixture()
    toto.authStatus.mockResolvedValue({ configured: false, signedIn: false, enforced: false, [field]: true })
    await expect(configureAndSeed(page, expected, async () => {})).rejects.toThrow()
    expect(toto.setSettings).not.toHaveBeenCalled()
    expect(toto.setApiKey).not.toHaveBeenCalled()
    expect(toto.saveTranscript).not.toHaveBeenCalled()
  })
  it('refuses ineffective deny-all or storage rebinding before content writes', async () => {
    const { page, toto } = pageFixture()
    toto.getSettings.mockResolvedValue({ ...settings(), allowedProviders: ['openai'] })
    await expect(configureAndSeed(page, expected, async () => {})).rejects.toThrow()
    expect(toto.saveTranscript).not.toHaveBeenCalled()
    toto.getSettings.mockResolvedValue(settings())
    toto.setSettings.mockResolvedValue({ ...settings(), resolvedMeetingsFolder: 'C:\\outside' })
    await expect(configureAndSeed(page, expected, async () => {})).rejects.toThrow()
    expect(toto.setApiKey).not.toHaveBeenCalled()
  })
  it('requires exact History, content and key-presence readback without reseeding', async () => {
    const { page, toto } = pageFixture()
    await readInstalledProfile(page, { ...expected, version: '1.9.6', file: 'meeting.md' })
    expect(toto.recallRead).toHaveBeenCalledWith('meeting.md')
    expect(toto.setSettings).not.toHaveBeenCalled()
    expect(toto.saveTranscript).not.toHaveBeenCalled()
    toto.recallRead.mockResolvedValue({ ok: true, title: expected.title, recap: '', lines: [{ text: 'lost content' }] })
    await expect(readInstalledProfile(page, { ...expected, version: '1.9.6', file: 'meeting.md' })).rejects.toThrow()
  })
  it('rejects extra History rows, changed settings and missing credential after restart', async () => {
    const { page, toto } = pageFixture()
    const read = () => readInstalledProfile(page, { ...expected, version: '1.9.6', file: 'meeting.md' })
    toto.recallList.mockResolvedValue([{ file: 'meeting.md', title: expected.title }, { file: 'extra.md', title: 'extra' }])
    await expect(read()).rejects.toThrow()
    toto.recallList.mockResolvedValue([{ file: 'meeting.md', title: expected.title }])
    toto.getSettings.mockResolvedValue({ ...settings(), temperature: 0.9 })
    await expect(read()).rejects.toThrow()
    toto.getSettings.mockResolvedValue({ ...settings(), hasKeys: { openai: false } })
    await expect(read()).rejects.toThrow()
  })
})

function driverFixture() {
  const calls: string[] = []
  let pid = 100
  const driver = {
    verifyInputs: vi.fn(async () => { calls.push('verify'); return true }),
    prepare: vi.fn(async () => { calls.push('prepare'); return expected }),
    install: vi.fn(async (version: string) => { calls.push(`install:${version}`); return {
      pid: version === '1.9.6' ? 50 : 51, exitCode: 0, censusConfirmed: true, closed: true
    } }),
    launch: vi.fn(async (version: string) => { calls.push(`launch:${version}`); return { pid: pid++, version } }),
    seed: vi.fn(async () => { calls.push('seed'); return `${expected.meetingsRoot}\\meeting.md` }),
    read: vi.fn(async (app: { version: string }) => { calls.push(`read:${app.version}`) }),
    inspect: vi.fn(async () => { calls.push('inspect'); return { native: true, settingsSha256: 'd'.repeat(64), meetingSha256: 'a'.repeat(64), providerSha256: 'b'.repeat(64), fileKeyPresent: false } }),
    stop: vi.fn(async () => { calls.push('stop'); return true }),
    cleanup: vi.fn(async () => { calls.push('cleanup'); return true })
  }
  return { driver, calls }
}
const context = { harnessCommit: 'c'.repeat(40) }
describe('historical installed orchestrator (system-boundary fixtures only)', () => {
  it('the real CLI refuses incomplete arguments with closed output before any installer work', () => {
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./historical-197-windows-upgrade.mjs', import.meta.url)),
      '--baseline', 'private-input-canary'], { encoding: 'utf8', timeout: 10_000 })
    expect(child.status).toBe(1)
    expect(child.stdout).toBe('')
    expect(child.stderr).toBe('historical-windows-native-upgrade:REFUSED\n')
  })
  it('runs original196 seed, same-root197 upgrade and independent fresh197 read in order', async () => {
    const { driver, calls } = driverFixture()
    const report = await runHistoricalUpgrade(context, driver)
    expect(calls).toEqual(['verify', 'prepare', 'install:1.9.6', 'launch:1.9.6', 'seed', 'read:1.9.6', 'stop', 'inspect',
      'install:1.9.7', 'launch:1.9.7', 'read:1.9.7', 'stop', 'inspect', 'launch:1.9.7', 'read:1.9.7', 'stop', 'inspect', 'cleanup'])
    expect(assessHistoricalUpgradeReport(report)).toBe(true)
    expect(driver.seed).toHaveBeenCalledOnce()
  })
  it('identity refusal cannot reach installation or profile preparation', async () => {
    const { driver } = driverFixture()
    driver.verifyInputs.mockResolvedValue(false)
    const report = await runHistoricalUpgrade(context, driver)
    expect(report.accepted).toBe(false)
    expect(driver.prepare).not.toHaveBeenCalled()
    expect(driver.install).not.toHaveBeenCalled()
  })
  it.each(['prepare', 'install', 'launch', 'seed', 'read', 'inspect', 'stop'] as const)('retains %s failure and cleans owned state', async (stage) => {
    const { driver } = driverFixture()
    driver[stage].mockRejectedValueOnce(new Error('private path/key must not escape'))
    const report = await runHistoricalUpgrade(context, driver)
    expect(report.accepted).toBe(false)
    expect(JSON.stringify(report)).not.toContain('private path')
    expect(driver.cleanup).toHaveBeenCalledOnce()
    expect(driver.launch.mock.calls.length).toBeLessThan(3)
  })
  it('rejects cleanup failure, reused process identity and changed ciphertext', async () => {
    const first = driverFixture()
    first.driver.cleanup.mockResolvedValue(false)
    expect((await runHistoricalUpgrade(context, first.driver)).accepted).toBe(false)
    const second = driverFixture()
    second.driver.launch.mockResolvedValue({ pid: 100, version: '1.9.7' })
    expect((await runHistoricalUpgrade(context, second.driver)).accepted).toBe(false)
    const third = driverFixture()
    third.driver.inspect.mockResolvedValueOnce({ native: true, settingsSha256: 'd'.repeat(64), meetingSha256: 'f'.repeat(64), providerSha256: 'b'.repeat(64), fileKeyPresent: false })
    expect((await runHistoricalUpgrade(context, third.driver)).accepted).toBe(false)
  })
  it('missing/duplicate/non-PASS rows cannot be accepted even with accepted:true', async () => {
    const report = await runHistoricalUpgrade(context, driverFixture().driver)
    for (const id of REQUIRED_CHECKS) {
      expect(assessHistoricalUpgradeReport({ ...report, checks: report.checks.filter((row: { id: string }) => row.id !== id) })).toBe(false)
      expect(assessHistoricalUpgradeReport({ ...report, checks: [...report.checks, { id, status: 'PASS' }] })).toBe(false)
      expect(assessHistoricalUpgradeReport({ ...report, checks: report.checks.map((row: { id: string }) => row.id === id ? { ...row, status: 'NOT_RUN' } : row) })).toBe(false)
    }
  })
})

describe('actual Windows driver boundaries (external Node/OS simulation, no installed acceptance)', () => {
  function installerPaths(root: string) {
    const home = join(root, 'home')
    return { home, userProfile: home, appData: join(home, 'roaming'), localAppData: join(home, 'local'),
      temp: join(home, 'temp'), userData: join(root, 'profile') }
  }
  async function setup() {
    const temp = await mkdtemp(join(tmpdir(), 'historical-driver-'))
    vi.stubEnv('RUNNER_TEMP', temp)
    const options = { root: join(temp, 'owned'), report: join(temp, 'report.json'), metadata: join(temp, 'metadata.json'),
      assets: join(temp, 'assets'), baseline: join(temp, 'baseline.exe'), harnessCommit: 'c'.repeat(40) }
    const driver = createWindowsDriver(options)
    const plan = await driver.prepare()
    vi.mocked(listProcesses).mockReturnValue([])
    return { temp, options, driver, plan }
  }
  it('refuses a real effective-storage junction before credential or transcript IPC writes', async () => {
    const fixture = await setup()
    try {
      const outside = join(fixture.temp, 'outside')
      await mkdir(outside)
      await rm(fixture.plan.meetingsRoot, { recursive: true })
      await symlink(outside, fixture.plan.meetingsRoot, 'junction')
      const { page, toto } = pageFixture()
      const actual = { ...settings(), meetingsFolder: fixture.plan.meetingsRoot, resolvedMeetingsFolder: fixture.plan.meetingsRoot }
      toto.getSettings.mockResolvedValue(actual)
      toto.setSettings.mockResolvedValue(actual)
      await expect(fixture.driver.seed({ page }, fixture.plan)).rejects.toThrow()
      expect(toto.setApiKey).not.toHaveBeenCalled()
      expect(toto.saveTranscript).not.toHaveBeenCalled()
    } finally { await rm(fixture.temp, { recursive: true, force: true }) }
  })
  it('passes only strict child environment to the owned asynchronous installer and requires its exit census', async () => {
    const fixture = await setup()
    try {
      vi.stubEnv('GITHUB_TOKEN', 'synthetic-must-not-inherit')
      vi.stubEnv('ASKTOTO_LOCAL_KEYSTORE', 'synthetic-must-not-inherit')
      const records: unknown[] = []
      const child = Object.assign(new EventEmitter(), { pid: 4321, exitCode: null as number | null, signalCode: null, kill: vi.fn() })
      vi.mocked(spawn).mockReturnValue(child as ReturnType<typeof spawn>)
      vi.mocked(spawnSync).mockImplementation(() => { throw new Error('synchronous installer forbidden') })
      vi.mocked(ownedCensus).mockImplementation(() => {
        expect(records).toHaveLength(1)
        return { owned: [{ pid: 4321, ppid: 1, startedMs: 1, exe: fixture.options.baseline }], roles: {} }
      })
      vi.mocked(listProcesses).mockReturnValue([])
      vi.mocked(waitForChildExit).mockImplementation(async () => {
        child.exitCode = 0
        await writeFile(join(fixture.options.root, 'install', 'Metis.exe'), 'synthetic installed-file boundary')
        return true
      })
      vi.mocked(disposeFreshOnboardingTransports).mockResolvedValue(true)
      await runOwnedInstaller(fixture.options.baseline, join(fixture.options.root, 'install'),
        installerPaths(fixture.options.root), records)
      const [, args, config] = vi.mocked(spawn).mock.calls.at(-1)!
      expect(args).toEqual(['/S', `/D=${join(fixture.options.root, 'install')}`])
      expect(config?.env?.ASKTOTO_USERDATA).toBe(join(fixture.options.root, 'profile'))
      expect(config?.env?.GITHUB_TOKEN).toBeUndefined()
      expect(config?.env?.ASKTOTO_LOCAL_KEYSTORE).toBeUndefined()
      expect(ownedCensus).toHaveBeenCalledWith(expect.objectContaining({ mainPid: 4321 }))
      expect(waitForChildExit).toHaveBeenCalledWith(child, 180_000)
      const stamp = await lstat(fixture.options.root)
      expect(await cleanupWindowsOwnership(records, { path: fixture.options.root, dev: stamp.dev, ino: stamp.ino })).toBe(true)
    } finally { await rm(fixture.temp, { recursive: true, force: true }) }
  })
  it('installer spawn or ownership uncertainty refuses cleanup deletion even before any app session', async () => {
    const fixture = await setup()
    try {
      const records: unknown[] = []
      vi.mocked(spawn).mockImplementation(() => { throw new Error('synthetic uncertain spawn') })
      vi.mocked(spawnSync).mockImplementation(() => { throw new Error('synchronous installer forbidden') })
      await expect(runOwnedInstaller(fixture.options.baseline, join(fixture.options.root, 'install'), installerPaths(fixture.options.root), records)).rejects.toThrow()
      expect(records).toHaveLength(1)
      const stamp = await lstat(fixture.options.root)
      expect(await cleanupWindowsOwnership(records, { path: fixture.options.root, dev: stamp.dev, ino: stamp.ino })).toBe(false)
      await expect(validateOwnedStoragePath(fixture.temp, fixture.options.root)).resolves.toBeTruthy()
    } finally { await rm(fixture.temp, { recursive: true, force: true }) }
  })
  it('actual driver rejects real tiny corrupt input before any installer spawn', async () => {
    const fixture = await setup()
    try {
      await writeFile(fixture.options.baseline, 'tiny corrupt input; never a real installer fixture')
      vi.mocked(spawn).mockClear()
      vi.mocked(spawnSync).mockClear()
      await expect(fixture.driver.install('1.9.6')).rejects.toThrow()
      expect(spawn).not.toHaveBeenCalled()
      expect(spawnSync).not.toHaveBeenCalled()
      expect(await fixture.driver.cleanup()).toBe(true)
    } finally { await rm(fixture.temp, { recursive: true, force: true }) }
  })
  it.each(['timeout', 'nonzero', 'spawn-error', 'census', 'transport'] as const)('installer %s cannot produce a successful lifecycle receipt', async (failure) => {
    const fixture = await setup()
    try {
      const records: unknown[] = []
      const child = Object.assign(new EventEmitter(), { pid: 4321, exitCode: null as number | null, signalCode: null, kill: vi.fn() })
      vi.mocked(spawn).mockReturnValue(child as ReturnType<typeof spawn>)
      vi.mocked(ownedCensus).mockImplementation(() => {
        if (failure === 'census') throw new Error('synthetic unavailable census')
        return { owned: [{ pid: 4321, ppid: 1, startedMs: 1, exe: fixture.options.baseline }], roles: {} }
      })
      vi.mocked(listProcesses).mockReturnValue([])
      let waits = 0
      vi.mocked(waitForChildExit).mockImplementation(async () => {
        waits += 1
        if (failure === 'timeout' && waits === 1) return false
        if (failure === 'spawn-error' && waits === 1) child.emit('error', new Error('synthetic spawn error'))
        child.exitCode = failure === 'nonzero' ? 9 : 0
        return true
      })
      vi.mocked(disposeFreshOnboardingTransports).mockResolvedValue(failure !== 'transport')
      await expect(runOwnedInstaller(fixture.options.baseline, join(fixture.options.root, 'install'), installerPaths(fixture.options.root), records)).rejects.toThrow()
      const stamp = await lstat(fixture.options.root)
      expect(await cleanupWindowsOwnership(records, { path: fixture.options.root, dev: stamp.dev, ino: stamp.ino })).toBe(false)
      // Confirmed nonzero exit can be safely removed, while every uncertainty retains the namespace.
      expect(await lstat(fixture.options.root).then(() => true, () => false)).toBe(failure !== 'nonzero')
    } finally { await rm(fixture.temp, { recursive: true, force: true }) }
  })
  it('tracks an observed installer descendant and refuses a clean pass if forced termination was needed', async () => {
    const fixture = await setup()
    try {
      const records: unknown[] = []
      const parent = { pid: 4321, ppid: 1, startedMs: 1, exe: fixture.options.baseline }
      const descendant = { pid: 4322, ppid: 4321, startedMs: 2, exe: join(fixture.temp, 'installer-child.exe') }
      const child = Object.assign(new EventEmitter(), { pid: 4321, exitCode: null as number | null, signalCode: null, kill: vi.fn() })
      vi.mocked(spawn).mockReturnValue(child as ReturnType<typeof spawn>)
      vi.mocked(ownedCensus).mockReturnValue({ owned: [parent, descendant], roles: {} })
      vi.mocked(waitForChildExit).mockImplementation(async () => { child.exitCode = 0; return true })
      vi.mocked(disposeFreshOnboardingTransports).mockResolvedValue(true)
      vi.mocked(listProcesses).mockReturnValue([descendant])
      vi.mocked(killOwned).mockImplementation(() => { vi.mocked(listProcesses).mockReturnValue([]) })
      await expect(runOwnedInstaller(fixture.options.baseline, join(fixture.options.root, 'install'), installerPaths(fixture.options.root), records)).rejects.toThrow()
      expect(killOwned).toHaveBeenCalledWith([descendant])
      const stamp = await lstat(fixture.options.root)
      expect(await cleanupWindowsOwnership(records, { path: fixture.options.root, dev: stamp.dev, ino: stamp.ino })).toBe(false)
    } finally { await rm(fixture.temp, { recursive: true, force: true }) }
  })
  it('retains the owned namespace when an installer descendant remains after bounded cleanup', async () => {
    const fixture = await setup()
    try {
      const records: unknown[] = []
      const parent = { pid: 4321, ppid: 1, startedMs: 1, exe: fixture.options.baseline }
      const descendant = { pid: 4322, ppid: 4321, startedMs: 2, exe: join(fixture.temp, 'installer-child.exe') }
      const child = Object.assign(new EventEmitter(), { pid: 4321, exitCode: null as number | null, signalCode: null, kill: vi.fn() })
      vi.mocked(spawn).mockReturnValue(child as ReturnType<typeof spawn>)
      vi.mocked(ownedCensus).mockReturnValue({ owned: [parent, descendant], roles: {} })
      vi.mocked(waitForChildExit).mockImplementation(async () => { child.exitCode = 0; return true })
      vi.mocked(disposeFreshOnboardingTransports).mockResolvedValue(true)
      vi.mocked(listProcesses).mockReturnValue([descendant])
      vi.mocked(killOwned).mockImplementation(() => {})
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
      const failing = expect(runOwnedInstaller(fixture.options.baseline, join(fixture.options.root, 'install'), installerPaths(fixture.options.root), records)).rejects.toThrow()
      await vi.advanceTimersByTimeAsync(5_000)
      await failing
      const stamp = await lstat(fixture.options.root)
      expect(await cleanupWindowsOwnership(records, { path: fixture.options.root, dev: stamp.dev, ino: stamp.ino })).toBe(false)
      await expect(validateOwnedStoragePath(fixture.temp, fixture.options.root)).resolves.toBeTruthy()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
      await rm(fixture.temp, { recursive: true, force: true })
    }
  })
  it.each(['root', 'parent'] as const)('does not claim or kill an unrelated process reusing the original %s PID', async (reuse) => {
    const fixture = await setup()
    try {
      const records: object[] = []
      const parent = { pid: 4321, ppid: 1, startedMs: 1, exe: fixture.options.baseline }
      const oldChild = { pid: 4322, ppid: 4321, startedMs: 2, exe: join(fixture.temp, 'old-helper.exe') }
      const replacement = { pid: reuse === 'root' ? 4321 : 4322, ppid: 99, startedMs: 10, exe: join(fixture.temp, 'unrelated.exe') }
      const unrelatedChild = { pid: 4999, ppid: replacement.pid, startedMs: 11, exe: join(fixture.temp, 'unrelated-child.exe') }
      const child = Object.assign(new EventEmitter(), { pid: 4321, exitCode: null as number | null, signalCode: null, kill: vi.fn() })
      vi.mocked(spawn).mockReturnValue(child as ReturnType<typeof spawn>)
      vi.mocked(ownedCensus).mockReturnValue({ owned: reuse === 'root' ? [parent] : [parent, oldChild], roles: {} })
      vi.mocked(waitForChildExit).mockImplementation(async () => { child.exitCode = 0; return true })
      vi.mocked(disposeFreshOnboardingTransports).mockResolvedValue(true)
      vi.mocked(listProcesses).mockReturnValue([replacement, unrelatedChild])
      vi.mocked(killOwned).mockImplementation(() => { vi.mocked(listProcesses).mockReturnValue([]) })
      await expect(runOwnedInstaller(fixture.options.baseline, join(fixture.options.root, 'install'), installerPaths(fixture.options.root), records)).resolves.toMatchObject({ closed: true })
      expect(killOwned).not.toHaveBeenCalled()
      expect(child.kill).not.toHaveBeenCalled()
      const owned = Reflect.get(records[0], 'owned')
      expect(owned.has(`${replacement.pid}:10`)).toBe(false)
      expect(owned.has('4999:11')).toBe(false)
    } finally { await rm(fixture.temp, { recursive: true, force: true }) }
  })
  it.each(['throw', 'invalid'] as const)('records app launch %s before the shared spawn boundary and retains its namespace', async (failure) => {
    const fixture = await setup()
    try {
      await writeFile(join(fixture.options.root, 'install', 'Metis.exe'), 'synthetic executable boundary; never launched')
      vi.mocked(launchPackagedCdp).mockImplementation(() => {
        if (failure === 'throw') throw new Error('synthetic early spawn failure')
        return Object.create(null)
      })
      await expect(fixture.driver.launch('1.9.6')).rejects.toThrow()
      expect(await fixture.driver.cleanup()).toBe(false)
      expect(listProcesses).toHaveBeenCalledWith('win32')
      await expect(validateOwnedStoragePath(fixture.temp, fixture.options.root)).resolves.toBeTruthy()
    } finally { await rm(fixture.temp, { recursive: true, force: true }) }
  })
  it.each(['occupied', 'unavailable'] as const)('requires a final root census with zero process receipts and retains an %s root', async (condition) => {
    const fixture = await setup()
    try {
      if (condition === 'occupied') vi.mocked(listProcesses).mockReturnValue([{ pid: 8000, ppid: 1, startedMs: 1, exe: join(fixture.options.root, 'install', 'unexpected.exe') }])
      else vi.mocked(listProcesses).mockImplementation(() => { throw new Error('synthetic unavailable final census') })
      expect(await fixture.driver.cleanup()).toBe(false)
      expect(killOwned).not.toHaveBeenCalled()
      await expect(validateOwnedStoragePath(fixture.temp, fixture.options.root)).resolves.toBeTruthy()
    } finally { await rm(fixture.temp, { recursive: true, force: true }) }
  })
  it('does not kill a captured PID/start pair whose current executable no longer matches', async () => {
    const fixture = await setup()
    try {
      const records: object[] = []
      const original = { pid: 4321, ppid: 1, startedMs: 1, exe: fixture.options.baseline }
      const conflict = { ...original, exe: join(fixture.temp, 'different-image.exe') }
      const child = Object.assign(new EventEmitter(), { pid: 4321, exitCode: null as number | null, signalCode: null, kill: vi.fn() })
      vi.mocked(spawn).mockReturnValue(child as ReturnType<typeof spawn>)
      vi.mocked(ownedCensus).mockReturnValue({ owned: [original], roles: {} })
      vi.mocked(waitForChildExit).mockImplementation(async () => { child.exitCode = 0; return true })
      vi.mocked(disposeFreshOnboardingTransports).mockResolvedValue(true)
      vi.mocked(listProcesses).mockReturnValue([conflict])
      await expect(runOwnedInstaller(fixture.options.baseline, join(fixture.options.root, 'install'), installerPaths(fixture.options.root), records)).rejects.toThrow()
      expect(killOwned).not.toHaveBeenCalled()
      expect(child.kill).not.toHaveBeenCalled()
      const stamp = await lstat(fixture.options.root)
      expect(await cleanupWindowsOwnership(records, { path: fixture.options.root, dev: stamp.dev, ino: stamp.ino })).toBe(false)
      await expect(validateOwnedStoragePath(fixture.temp, fixture.options.root)).resolves.toBeTruthy()
    } finally { await rm(fixture.temp, { recursive: true, force: true }) }
  })
})
