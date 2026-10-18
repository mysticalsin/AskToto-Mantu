import { describe, expect, it, vi, afterEach } from 'vitest'
import { Buffer } from 'node:buffer'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  assessNativeFiles,
  assessHistoricalUpgradeReport,
  configureAndSeed,
  readInstalledProfile,
  runHistoricalUpgrade,
  REQUIRED_CHECKS,
  validateOwnedStoragePath
} from './historical-197-windows-upgrade.mjs'

afterEach(() => vi.unstubAllGlobals())

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
    const saved = await configureAndSeed(page, expected)
    expect(saved).toBe(`${expected.meetingsRoot}\\meeting.md`)
    expect(toto.setSettings).toHaveBeenCalledWith(expect.objectContaining({ meetingsFolder: expected.meetingsRoot }))
    expect(toto.setSettings.mock.invocationCallOrder[0]).toBeLessThan(toto.setApiKey.mock.invocationCallOrder[0])
    expect(toto.setApiKey.mock.invocationCallOrder[0]).toBeLessThan(toto.saveTranscript.mock.invocationCallOrder[0])
    expect(toto.saveTranscript).toHaveBeenCalledWith({
      title: expected.title, mode: 'general', startedAt: expected.startedAt, durationMs: 64000,
      lines: [{ speaker: 'you', text: expected.line, t: expected.startedAt + 2000 }], recap: ''
    })
  })
  it.each(['configured', 'signedIn', 'enforced'] as const)('refuses unexpected auth %s before writes', async (field) => {
    const { page, toto } = pageFixture()
    toto.authStatus.mockResolvedValue({ configured: false, signedIn: false, enforced: false, [field]: true })
    await expect(configureAndSeed(page, expected)).rejects.toThrow()
    expect(toto.setSettings).not.toHaveBeenCalled()
    expect(toto.setApiKey).not.toHaveBeenCalled()
    expect(toto.saveTranscript).not.toHaveBeenCalled()
  })
  it('refuses ineffective deny-all or storage rebinding before content writes', async () => {
    const { page, toto } = pageFixture()
    toto.getSettings.mockResolvedValue({ ...settings(), allowedProviders: ['openai'] })
    await expect(configureAndSeed(page, expected)).rejects.toThrow()
    expect(toto.saveTranscript).not.toHaveBeenCalled()
    toto.getSettings.mockResolvedValue(settings())
    toto.setSettings.mockResolvedValue({ ...settings(), resolvedMeetingsFolder: 'C:\\outside' })
    await expect(configureAndSeed(page, expected)).rejects.toThrow()
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
    install: vi.fn(async (version: string) => { calls.push(`install:${version}`) }),
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
