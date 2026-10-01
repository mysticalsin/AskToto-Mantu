import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { recordProblems } from '../evidence/record.mjs'
import { selectCandidateInstaller } from './candidate-installer.mjs'
import {
  SCENARIOS,
  assertCandidateProvenance,
  candidateRunProblems,
  contentProblems,
  laneAnnotation,
  laneRecord,
  laneSummary,
  outcomeForExit,
  prepareProfile,
  resolveOutputs,
  resolveScenario,
  scanUploadDir,
  scenarioCommand
} from './candidate-scenarios.mjs'
import { LOCAL_LLM_SETTINGS } from './lib/local-llm-settings.mjs'
import { VARIANTS } from './provenance.mjs'

const root = join(__dirname, '..', '..')
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const MAC_SHA = sha('qa zip bytes')
const STALL_SHA = sha('promotable dmg bytes')
const IDLE_SHA = sha('idle soak dmg bytes')
const WIN_SHA = sha('setup bytes')
const COMMIT = 'a'.repeat(40)

const successfulDispatch = {
  id: 4242,
  path: '.github/workflows/qa-candidate.yml',
  event: 'workflow_dispatch',
  head_branch: 'main',
  status: 'completed',
  conclusion: 'success'
}

describe('candidateRunProblems (the run guard)', () => {
  it('accepts a completed, successful workflow_dispatch run of qa-candidate.yml on main', () => {
    expect(candidateRunProblems(successfulDispatch, '4242')).toEqual([])
    expect(candidateRunProblems({ ...successfulDispatch, path: '.github/workflows/qa-candidate.yml@refs/heads/main' }, 4242)).toEqual([])
  })

  it('refuses a pull-request self-test candidate', () => {
    const selfTest = { ...successfulDispatch, event: 'pull_request', head_branch: 'm2/M2-0467-add-shared-main-only' }
    const problems = candidateRunProblems(selfTest, 4242)
    expect(problems.join('\n')).toMatch(/pull_request, not workflow_dispatch/)
    expect(problems.join('\n')).toMatch(/not main/)
  })

  it('refuses another workflow, another branch, an unfinished or failed run, and a different run id', () => {
    expect(candidateRunProblems({ ...successfulDispatch, path: '.github/workflows/build.yml' }, 4242)).toEqual([
      'Run 4242 is .github/workflows/build.yml, not .github/workflows/qa-candidate.yml.'
    ])
    expect(candidateRunProblems({ ...successfulDispatch, head_branch: 'release' }, 4242)).toHaveLength(1)
    expect(candidateRunProblems({ ...successfulDispatch, status: 'in_progress', conclusion: null }, 4242)).toHaveLength(2)
    expect(candidateRunProblems({ ...successfulDispatch, conclusion: 'failure' }, 4242)).toEqual([
      'Run 4242 concluded failure, not success.'
    ])
    expect(candidateRunProblems(successfulDispatch, 4243)).toHaveLength(1)
    expect(candidateRunProblems(null, 4242)).toEqual(['The run JSON is not an object.'])
  })
})

describe('the scenario registry', () => {
  it('declares fault-fatal-relaunch on macOS, installing the Metis-QA zip variant', () => {
    expect(Object.keys(SCENARIOS)).toEqual(['fault-fatal-relaunch', 'ex-suite', 'stall-sampler', 'idle-soak', 'sidecar-boot-reaper'])
    const mac = SCENARIOS['fault-fatal-relaunch'].platforms.mac
    expect(Object.keys(SCENARIOS['fault-fatal-relaunch'].platforms)).toEqual(['mac'])
    expect(mac.variant).toBe('mac-qa-identity')
    expect(mac.artifact).toBe('candidate-mac-qa-identity')
    expect(VARIANTS['mac-qa-identity'].assets('1.0.0')).toEqual(['Metis-QA-1.0.0.zip'])
    expect(mac.script).toBe('scripts/qa/fault-fatal-relaunch.mjs')
    expect(existsSync(join(root, mac.script))).toBe(true)
    expect(mac.report).toBe('fault-fatal-relaunch.json')
    expect(mac.settings).toEqual(LOCAL_LLM_SETTINGS)
    expect(LOCAL_LLM_SETTINGS.localLlm).toMatchObject({ enabled: true, modelId: 'qwen3.5-0.8b' })
  })

  it('declares ex-suite on macOS, installing the promotable Metis DMG and seeding no lane settings', () => {
    const entry = SCENARIOS['ex-suite']
    expect(entry.ticket).toBe('M2-0033')
    expect(entry.qaOnlyHook).toBe(false)
    expect(entry.exits).toEqual({ 0: 'PASS', 1: 'FAIL', 2: 'PRECONDITION' })
    expect(Object.keys(entry.platforms)).toEqual(['mac'])
    const mac = entry.platforms.mac
    expect(mac.variant).toBe('mac')
    expect(mac.artifact).toBe('candidate-mac')
    expect(VARIANTS.mac.promotable).toBe(true)
    expect(VARIANTS.mac.assets('1.0.0')).toContain('Metis-1.0.0.dmg')
    expect(mac.installerSuffix).toBe('.dmg')
    expect(mac.script).toBe('scripts/qa/ex-suite.mjs')
    expect(existsSync(join(root, mac.script))).toBe(true)
    expect(mac.report).toBe('ex-suite.json')
    expect('settings' in mac).toBe(false)
    expect(resolveScenario({ scenario: 'ex-suite', sha256: { mac: MAC_SHA } })).toEqual({
      mac: { variant: 'mac', artifact: 'candidate-mac', sha256: MAC_SHA }
    })
    expect(() => resolveScenario({ scenario: 'ex-suite', sha256: { mac: MAC_SHA, win: MAC_SHA } })).toThrow(/does not run on win/)
    expect(outcomeForExit('ex-suite', 2)).toBe('PRECONDITION')
  })

  it('runs ex-suite --packaged on the installed app, relative to the checkout, with 3 launches, and only from a DMG', () => {
    const base = { scenario: 'ex-suite', platform: 'mac', sha256: MAC_SHA, outDir: 'candidate-scenario' }
    expect(scenarioCommand({ ...base, installer: 'assets/Metis-1.0.0.dmg', app: '../../_temp/candidate-install/Metis.app' })).toEqual([
      'scripts/qa/ex-suite.mjs',
      '--packaged',
      '../../_temp/candidate-install/Metis.app',
      'candidate-scenario/ex-suite.json',
      '--relaunches',
      '3'
    ])
    expect(() => scenarioCommand({ ...base, installer: 'assets/Metis-1.0.0.zip', app: 'Metis.app' })).toThrow(/installs a \.dmg installer/)
    expect(() => scenarioCommand({ ...base, installer: 'assets/Metis-1.0.0.dmg' })).toThrow(/needs the installed app/)
    expect(() => scenarioCommand({ ...base, installer: 'assets/Metis-1.0.0.dmg', app: '/tmp/candidate-install/Metis.app' })).toThrow(
      /repository-relative/
    )
  })

  it('declares stall-sampler on macOS, installing promotable DMG bytes and using the 15 s stop', () => {
    const mac = SCENARIOS['stall-sampler'].platforms.mac
    expect(Object.keys(SCENARIOS['stall-sampler'].platforms)).toEqual(['mac'])
    expect(SCENARIOS['stall-sampler'].qaOnlyHook).toBe(false)
    expect(mac.variant).toBe('mac')
    expect(mac.artifact).toBe('candidate-mac')
    expect(VARIANTS.mac.assets('1.0.0')).toEqual(['Metis-1.0.0.dmg', 'Metis-1.0.0.zip'])
    expect(mac.script).toBe('scripts/qa/stall-sampler-hosted.mjs')
    expect(existsSync(join(root, mac.script))).toBe(true)
    expect(mac.args({ app: 'candidate-install/Metis.app', report: 'candidate-scenario/stall-sampler.json' })).toEqual([
      'candidate-install/Metis.app',
      'candidate-scenario/stall-sampler.json',
      '--stop-seconds',
      '15'
    ])
    expect(mac.report).toBe('stall-sampler.json')
    expect(Object.hasOwn(mac, 'settings')).toBe(false)
  })

  it('binds every entry to a qa-candidate artifact of its platform, and to promotable bytes unless it needs a QA-only hook', () => {
    for (const [name, scenario] of Object.entries(SCENARIOS)) {
      for (const [platform, target] of Object.entries(scenario.platforms)) {
        const variant = VARIANTS[target.variant as keyof typeof VARIANTS]
        expect(variant, `${name} ${platform}`).toBeDefined()
        expect(variant.platform).toBe(platform)
        expect(target.artifact).toBe(`candidate-${target.variant}`)
        expect(variant.promotable).toBe(!scenario.qaOnlyHook)
      }
    }
  })

  it('declares idle-soak on macOS, installing promotable DMG bytes with the hosted long-run timeout', () => {
    const scenario = SCENARIOS['idle-soak']
    const mac = scenario.platforms.mac
    expect(scenario.ticket).toBe('M2-0492')
    expect(scenario.qaOnlyHook).toBe(false)
    expect(scenario.exits).toEqual({ 0: 'PASS', 1: 'FAIL_OR_INCOMPLETE', 2: 'PRECONDITION' })
    expect(Object.keys(scenario.platforms)).toEqual(['mac'])
    expect(mac).toMatchObject({
      variant: 'mac',
      artifact: 'candidate-mac',
      script: 'scripts/qa/soak/idle-soak.mjs',
      report: 'idle-soak.json',
      profileLayout: 'hide',
      timeoutMinutes: 355,
      stepTimeoutMinutes: 340
    })
    expect(mac.outcomeFromReport).toBe(true)
    expect(existsSync(join(root, mac.script))).toBe(true)
    expect(VARIANTS.mac.assets('1.0.0')).toContain('Metis-1.0.0.dmg')
    expect(mac.args({ app: 'candidate-install/Metis.app', report: 'candidate-scenario/idle-soak.json' })).toEqual([
      '--app',
      'candidate-install/Metis.app',
      '--profile',
      'candidate-scenario/profile',
      '--hours',
      '5.5',
      '--out',
      'candidate-scenario'
    ])
    expect(mac.laneReportFields).toEqual([
      'rule',
      'hoursMeasured',
      'parkedCoverage',
      'displayAwake',
      'hostFloorOverride',
      'hostMemory',
      'modelState'
    ])
  })

  it('requires the sha256 inputs a scenario needs and refuses any it does not use', () => {
    expect(resolveScenario({ scenario: 'fault-fatal-relaunch', sha256: { mac: ` ${MAC_SHA.toUpperCase()}\n`, win: '' } })).toEqual({
      mac: { variant: 'mac-qa-identity', artifact: 'candidate-mac-qa-identity', sha256: MAC_SHA, timeoutMinutes: 60, stepTimeoutMinutes: 40 }
    })
    expect(() => resolveScenario({ scenario: 'fault-fatal-relaunch', sha256: { mac: '' } })).toThrow(/mac_sha256 is required/)
    expect(() => resolveScenario({ scenario: 'fault-fatal-relaunch', sha256: { mac: 'v1.9.6' } })).toThrow(/mac_sha256 is required/)
    expect(() => resolveScenario({ scenario: 'fault-fatal-relaunch', sha256: { mac: MAC_SHA, win: MAC_SHA } })).toThrow(
      /win_sha256 is set, but fault-fatal-relaunch does not run on win/
    )
    expect(resolveScenario({ scenario: 'stall-sampler', sha256: { mac: STALL_SHA, win: '' } })).toEqual({
      mac: { variant: 'mac', artifact: 'candidate-mac', sha256: STALL_SHA, timeoutMinutes: 60, stepTimeoutMinutes: 40 }
    })
    expect(resolveScenario({ scenario: 'idle-soak', sha256: { mac: IDLE_SHA, win: '' } })).toEqual({
      mac: { variant: 'mac', artifact: 'candidate-mac', sha256: IDLE_SHA, timeoutMinutes: 355, stepTimeoutMinutes: 340 }
    })
    expect(() => resolveScenario({ scenario: 'hk-m', sha256: { mac: MAC_SHA } })).toThrow(/Unknown scenario "hk-m"/)
    expect(() => resolveScenario({ scenario: 'toString', sha256: { mac: MAC_SHA } })).toThrow(/Unknown scenario/)
  })

  it('publishes one job switch per platform for the workflow', () => {
    const plan = resolveScenario({ scenario: 'stall-sampler', sha256: { mac: STALL_SHA } })
    expect(resolveOutputs(plan)).toBe(
      `mac=true\nmac_variant=mac\nmac_artifact=candidate-mac\nmac_sha256=${STALL_SHA}\nmac_timeout_minutes=60\nmac_step_timeout_minutes=40\nwin=false\n`
    )
  })

  it('publishes the long mac timeout only for idle-soak', () => {
    const plan = resolveScenario({ scenario: 'idle-soak', sha256: { mac: IDLE_SHA } })
    expect(resolveOutputs(plan)).toBe(
      `mac=true\nmac_variant=mac\nmac_artifact=candidate-mac\nmac_sha256=${IDLE_SHA}\nmac_timeout_minutes=355\nmac_step_timeout_minutes=340\nwin=false\n`
    )
  })

  it('declares sidecar-boot-reaper on the promotable mac DMG (real llama-server required) and the win Setup', () => {
    const scenario = SCENARIOS['sidecar-boot-reaper']
    expect(scenario.ticket).toBe('M2-0027')
    expect(scenario.qaOnlyHook).toBe(false)
    expect(scenario.exits).toEqual({ 0: 'PASS', 1: 'FAIL', 2: 'PRECONDITION' })
    expect(Object.keys(scenario.platforms)).toEqual(['mac', 'win'])
    const { mac, win } = scenario.platforms
    expect(mac).toMatchObject({ variant: 'mac', artifact: 'candidate-mac', report: 'sidecar-boot-reaper.json', isolatedProfiles: true })
    expect(win).toMatchObject({ variant: 'win', artifact: 'candidate-win', report: 'sidecar-boot-reaper.json', isolatedProfiles: true })
    for (const target of [mac, win]) {
      expect(target.script).toBe('scripts/qa/sidecar-boot-reaper.mjs')
      expect(existsSync(join(root, target.script))).toBe(true)
    }
    expect(VARIANTS.mac.assets('1.0.0')).toContain('Metis-1.0.0.dmg')
    expect(VARIANTS.win.assets('1.0.0')).toContain('Metis-Setup-1.0.0.exe')
    expect('notCovered' in mac).toBe(false)
    expect(win.notCovered.map(({ row }) => row)).toEqual(['realLlama', 'legacyOrphan'])
  })

  it('requires both the DMG and the Setup sha256 for sidecar-boot-reaper and switches both jobs on', () => {
    expect(() => resolveScenario({ scenario: 'sidecar-boot-reaper', sha256: { mac: MAC_SHA } })).toThrow(/win_sha256 is required/)
    expect(() => resolveScenario({ scenario: 'sidecar-boot-reaper', sha256: { win: WIN_SHA } })).toThrow(/mac_sha256 is required/)
    const plan = resolveScenario({ scenario: 'sidecar-boot-reaper', sha256: { mac: MAC_SHA, win: WIN_SHA } })
    expect(plan).toEqual({
      mac: { variant: 'mac', artifact: 'candidate-mac', sha256: MAC_SHA, timeoutMinutes: 60, stepTimeoutMinutes: 40 },
      win: { variant: 'win', artifact: 'candidate-win', sha256: WIN_SHA, timeoutMinutes: 60, stepTimeoutMinutes: 40 }
    })
    expect(resolveOutputs(plan)).toBe(
      `mac=true\nmac_variant=mac\nmac_artifact=candidate-mac\nmac_sha256=${MAC_SHA}\nmac_timeout_minutes=60\nmac_step_timeout_minutes=40\n` +
        `win=true\nwin_variant=win\nwin_artifact=candidate-win\nwin_sha256=${WIN_SHA}\nwin_timeout_minutes=60\nwin_step_timeout_minutes=40\n`
    )
  })

  it('runs the reaper on the installed app with --require-real-llama on macOS only', () => {
    const base = { scenario: 'sidecar-boot-reaper', sha256: MAC_SHA, outDir: 'candidate-scenario' }
    expect(scenarioCommand({ ...base, platform: 'mac', installer: 'assets/Metis-1.0.0.dmg', app: '../../_temp/candidate-install/Metis.app' })).toEqual([
      'scripts/qa/sidecar-boot-reaper.mjs',
      '../../_temp/candidate-install/Metis.app',
      'candidate-scenario/sidecar-boot-reaper.json',
      '--require-real-llama'
    ])
    expect(scenarioCommand({ ...base, platform: 'win', installer: 'assets/Metis-Setup-1.0.0.exe', app: '../../_temp/candidate-install/Metis.exe' })).toEqual([
      'scripts/qa/sidecar-boot-reaper.mjs',
      '../../_temp/candidate-install/Metis.exe',
      'candidate-scenario/sidecar-boot-reaper.json'
    ])
    expect(() => scenarioCommand({ ...base, platform: 'mac', installer: 'assets/Metis-1.0.0.dmg' })).toThrow(/pass the installed app with --app/)
    expect(() => scenarioCommand({ ...base, platform: 'win', installer: 'a.exe', app: 'D:\\a\\_temp\\Metis.exe' })).toThrow(/repository-relative/)
    expect(outcomeForExit('sidecar-boot-reaper', 2)).toBe('PRECONDITION')
    expect(outcomeForExit('sidecar-boot-reaper', 0)).toBe('PASS')
  })
})

describe('installer selection through candidate-installer', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'candidate-scenarios-assets-'))
    writeFileSync(join(dir, 'Metis-QA-1.0.0.zip'), 'qa zip bytes')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('selects the scenario installer only when its bytes match the resolved sha256', async () => {
    const plan = resolveScenario({ scenario: 'fault-fatal-relaunch', sha256: { mac: MAC_SHA } })
    expect(await selectCandidateInstaller(dir, plan.mac.sha256, 'mac')).toBe(join(dir, 'Metis-QA-1.0.0.zip'))
    await expect(selectCandidateInstaller(dir, sha('another build'), 'mac')).rejects.toThrow(/No installer matches/)
  })

  it('selects only the promotable DMG for idle-soak', async () => {
    writeFileSync(join(dir, 'Metis-1.0.0.dmg'), 'idle soak dmg bytes')
    writeFileSync(join(dir, 'Metis-1.0.0.zip'), 'idle soak zip bytes')
    const plan = resolveScenario({ scenario: 'idle-soak', sha256: { mac: IDLE_SHA } })
    expect(await selectCandidateInstaller(dir, plan.mac.sha256, 'mac-dmg')).toBe(join(dir, 'Metis-1.0.0.dmg'))
    await expect(selectCandidateInstaller(dir, sha('idle soak zip bytes'), 'mac-dmg')).rejects.toThrow(/No installer matches/)
  })

  it('selects the Setup, never the Portable, for the sidecar-boot-reaper win leg', async () => {
    writeFileSync(join(dir, 'Metis-Setup-1.0.0.exe'), 'setup bytes')
    writeFileSync(join(dir, 'Metis-Portable-1.0.0.exe'), 'portable bytes')
    const plan = resolveScenario({ scenario: 'sidecar-boot-reaper', sha256: { mac: MAC_SHA, win: WIN_SHA } })
    expect(await selectCandidateInstaller(dir, plan.win.sha256, 'win')).toBe(join(dir, 'Metis-Setup-1.0.0.exe'))
    await expect(selectCandidateInstaller(dir, sha('portable bytes'), 'win')).rejects.toThrow(/No installer matches/)
  })
})

describe('the fresh profile', () => {
  let appData: string
  beforeEach(() => {
    appData = mkdtempSync(join(tmpdir(), 'candidate-scenarios-appdata-'))
  })
  afterEach(() => rmSync(appData, { recursive: true, force: true }))

  it('seeds only the scenario settings into the QA userData directory', () => {
    const settings = prepareProfile({ scenario: 'fault-fatal-relaunch', platform: 'mac', appDataDir: appData })
    expect(settings).toBe(join(appData, 'asktoto-qa', 'settings.json'))
    expect(JSON.parse(readFileSync(settings as string, 'utf8'))).toEqual(LOCAL_LLM_SETTINGS)
  })

  it('checks that the shipping userData directory is fresh for ex-suite and seeds nothing into it', () => {
    expect(prepareProfile({ scenario: 'ex-suite', platform: 'mac', appDataDir: appData })).toBeNull()
    expect(existsSync(join(appData, 'asktoto'))).toBe(false)
    mkdirSync(join(appData, 'asktoto'))
    expect(() => prepareProfile({ scenario: 'ex-suite', platform: 'mac', appDataDir: appData })).toThrow(
      /asktoto userData directory already exists/
    )
  })

  it('does not seed settings for the promotable stall-sampler profile', () => {
    const settings = prepareProfile({ scenario: 'stall-sampler', platform: 'mac', appDataDir: appData })
    expect(settings).toBeNull()
    expect(existsSync(join(appData, 'asktoto'))).toBe(false)
  })

  it('builds the idle-soak representative Hide profile with local LLM enabled', () => {
    const cwd = process.cwd()
    const scratch = mkdtempSync(join(tmpdir(), 'candidate-scenarios-idle-profile-'))
    try {
      process.chdir(scratch)
      const manifest = prepareProfile({ scenario: 'idle-soak', platform: 'mac', appDataDir: appData })
      expect(manifest).toBe(join(scratch, 'candidate-scenario', 'profile', 'resource-census-profile.json'))
      const parsed = JSON.parse(readFileSync(manifest as string, 'utf8'))
      expect(parsed).toMatchObject({
        profileKind: 'representative-synthetic',
        layout: 'hide',
        localLlm: { enabled: true, modelId: 'qwen3.5-0.8b' }
      })
      expect(() => prepareProfile({ scenario: 'idle-soak', platform: 'mac', appDataDir: appData })).toThrow(/idle-soak profile directory already exists/)
    } finally {
      process.chdir(cwd)
      rmSync(scratch, { recursive: true, force: true })
    }
  })


  it('refuses a QA userData directory that already exists', () => {
    mkdirSync(join(appData, 'asktoto-qa'))
    expect(() => prepareProfile({ scenario: 'fault-fatal-relaunch', platform: 'mac', appDataDir: appData })).toThrow(
      /asktoto-qa userData directory already exists/
    )
    expect(existsSync(join(appData, 'asktoto-qa', 'settings.json'))).toBe(false)
  })

  it('writes nothing for a scenario that runs only on its own isolated profiles, on either platform', () => {
    expect(prepareProfile({ scenario: 'sidecar-boot-reaper', platform: 'mac', appDataDir: appData })).toBeNull()
    expect(prepareProfile({ scenario: 'sidecar-boot-reaper', platform: 'win', appDataDir: null })).toBeNull()
    expect(readdirSync(appData)).toEqual([])
    expect(() => prepareProfile({ scenario: 'fault-fatal-relaunch', platform: 'mac', appDataDir: null })).toThrow(
      /No fresh-profile location is declared for mac/
    )
  })
})

describe('outcomeForExit', () => {
  it('maps 0 to PASS, 1 to FAIL and 2 to PRECONDITION; anything else is a FAIL', () => {
    expect(outcomeForExit('fault-fatal-relaunch', 0)).toBe('PASS')
    expect(outcomeForExit('fault-fatal-relaunch', 1)).toBe('FAIL')
    expect(outcomeForExit('fault-fatal-relaunch', 2)).toBe('PRECONDITION')
    expect(outcomeForExit('stall-sampler', 0)).toBe('PASS')
    expect(outcomeForExit('stall-sampler', 1)).toBe('FAIL')
    expect(outcomeForExit('stall-sampler', 2)).toBe('PRECONDITION')
    expect(outcomeForExit('fault-fatal-relaunch', 3)).toBe('FAIL')
    expect(outcomeForExit('fault-fatal-relaunch', null)).toBe('FAIL')
  })
})

describe('contentProblems (the content-free gate)', () => {
  const account = 'qa-account'

  it('flags a macOS, Linux or Windows user home path', () => {
    expect(contentProblems('bundle at /Users/someone/Library', { account })).toEqual(['macOS user home path'])
    expect(contentProblems('{"cwd":"/home/someone/work"}', { account })).toEqual(['Linux user home path'])
    expect(contentProblems('C:\\Users\\someone\\AppData', { account })).toEqual(['Windows user home path'])
    expect(contentProblems('{"p":"c:\\\\users\\\\someone\\\\x"}', { account })).toEqual(['Windows user home path'])
  })

  it('flags an email address', () => {
    expect(contentProblems('reported by someone@example.org', { account })).toEqual(['email address'])
  })

  it('flags the runner account name where it names an identity', () => {
    for (const text of ['/private/var/qa-account/x', '~qa-account', 'qa-account@host', '{"user":"qa-account"}', 'D:\\qa-account\\x']) {
      expect(contentProblems(text, { account }), text).toEqual(['runner account name'])
    }
  })

  it('passes content-free text, including the hosted-runner kind when the account is runner', () => {
    expect(contentProblems('{"environment":{"kind":"hosted-runner"},"runner_image":{"label":"macos-latest"}}', { account: 'runner' })).toEqual([])
    expect(contentProblems('grant Accessibility to the runner (M2-0007)', { account: 'runner' })).toEqual([])
    expect(contentProblems('{"phases":[{"survivors":[],"strays":[]}],"result":"PASS"}', { account })).toEqual([])
  })

  it('removes every offending file from the upload directory and keeps the clean ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'candidate-scenarios-scan-'))
    try {
      writeFileSync(join(dir, 'lane.json'), '{"outcome":"PASS"}')
      writeFileSync(join(dir, 'report.json'), '{"path":"/Users/someone/x","by":"someone@example.org"}')
      expect(scanUploadDir(dir, { account })).toEqual(['report.json: macOS user home path', 'report.json: email address'])
      expect(existsSync(join(dir, 'report.json'))).toBe(false)
      expect(existsSync(join(dir, 'lane.json'))).toBe(true)
      expect(scanUploadDir(join(dir, 'missing'), { account })).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('lane.json', () => {
  const provenance = { commit: COMMIT, run: { id: 4242 } }
  const env = { GITHUB_RUN_ID: '5151', ImageOS: 'macos15', ImageVersion: '20260920.1' }
  const argv = scenarioCommand({
    scenario: 'fault-fatal-relaunch',
    platform: 'mac',
    installer: 'assets/Metis-QA-1.0.0.zip',
    sha256: MAC_SHA,
    outDir: 'candidate-scenario'
  })
  const lane = (exitCode: number | null, detail = '') =>
    laneRecord({
      scenario: 'fault-fatal-relaunch',
      platform: 'mac',
      env,
      provenance,
      candidateRun: '4242',
      installer: 'assets/Metis-QA-1.0.0.zip',
      sha256: MAC_SHA,
      argv,
      exitCode,
      detail,
      reportWritten: exitCode !== 2
    })

  it('runs the proof with the QA zip, its sha256 and a repository-relative report path', () => {
    expect(argv).toEqual([
      'scripts/qa/fault-fatal-relaunch.mjs',
      '--zip',
      'assets/Metis-QA-1.0.0.zip',
      '--sha256',
      MAC_SHA,
      '--out',
      'candidate-scenario/fault-fatal-relaunch.json'
    ])
    const absolute = { scenario: 'fault-fatal-relaunch', platform: 'mac', sha256: MAC_SHA, outDir: 'candidate-scenario' }
    expect(() => scenarioCommand({ ...absolute, installer: '/tmp/Metis-QA.zip' })).toThrow(/repository-relative/)
    expect(() => scenarioCommand({ ...absolute, installer: 'C:\\temp\\Metis-QA.zip' })).toThrow(/repository-relative/)
    expect(() => scenarioCommand({ ...absolute, platform: 'win', installer: 'assets/x.exe' })).toThrow(/does not run on win/)
  })

  it('runs the stall sampler proof against the installed app with a 15 s stop', () => {
    const argv = scenarioCommand({
      scenario: 'stall-sampler',
      platform: 'mac',
      installer: 'assets/Metis-1.0.0.dmg',
      app: 'candidate-install/Metis.app',
      sha256: STALL_SHA,
      outDir: 'candidate-scenario'
    })
    expect(argv).toEqual([
      'scripts/qa/stall-sampler-hosted.mjs',
      'candidate-install/Metis.app',
      'candidate-scenario/stall-sampler.json',
      '--stop-seconds',
      '15'
    ])
    expect(() =>
      scenarioCommand({
        scenario: 'stall-sampler',
        platform: 'mac',
        installer: 'assets/Metis-1.0.0.dmg',
        app: '/tmp/Metis.app',
        sha256: STALL_SHA,
        outDir: 'candidate-scenario'
      })
    ).toThrow(/repository-relative/)
  })

  it('runs idle-soak against the installed app, generated Hide profile and upload-safe deadline', () => {
    const previous = process.env.SOAK_DEADLINE_EPOCH_MS
    process.env.SOAK_DEADLINE_EPOCH_MS = '1790000000000'
    try {
      const argv = scenarioCommand({
        scenario: 'idle-soak',
        platform: 'mac',
        installer: 'assets/Metis-1.0.0.dmg',
        app: 'candidate-install/Metis.app',
        sha256: IDLE_SHA,
        outDir: 'candidate-scenario'
      })
      expect(argv).toEqual([
        'scripts/qa/soak/idle-soak.mjs',
        '--app',
        'candidate-install/Metis.app',
        '--profile',
        'candidate-scenario/profile',
        '--hours',
        '5.5',
        '--out',
        'candidate-scenario',
        '--deadline-epoch-ms',
        '1790000000000'
      ])
    } finally {
      if (previous === undefined) delete process.env.SOAK_DEADLINE_EPOCH_MS
      else process.env.SOAK_DEADLINE_EPOCH_MS = previous
    }
  })

  it('records the evidence-record fields of the run', () => {
    expect(lane(0)).toEqual({
      schema: 1,
      scenario: 'fault-fatal-relaunch',
      ticket: 'M2-0026',
      platform: 'mac',
      runner_image: { label: 'macos-latest', image_os: 'macos15', image_version: '20260920.1' },
      build_run_id: 4242,
      commit: COMMIT,
      variant: 'mac-qa-identity',
      installer: 'Metis-QA-1.0.0.zip',
      artifact_sha256: MAC_SHA,
      ci_run_id: 5151,
      environment: { kind: 'hosted-runner', host: 'macos-latest' },
      command: `node scripts/qa/fault-fatal-relaunch.mjs --zip assets/Metis-QA-1.0.0.zip --sha256 ${MAC_SHA} --out candidate-scenario/fault-fatal-relaunch.json`,
      exit_code: 0,
      outcome: 'PASS',
      report: 'fault-fatal-relaunch.json',
      detail: null
    })
  })

  it('copies straight into a valid LIVE_VERIFIED record', () => {
    const { build_run_id, commit, artifact_sha256, ci_run_id, environment, command, exit_code } = lane(0)
    const record = {
      schema: 1,
      ticket: 'M2-0026',
      evidence_level: 'LIVE_VERIFIED',
      recorded_at: '2026-09-29T00:00:00Z',
      kit_refs: {},
      finding_refs: [],
      commit,
      result: 'PASS',
      implementer_session: { model: 'claude-opus-5-5', id: 'impl-1' },
      validator_session: { model: 'claude-opus-5-5', id: 'valid-1' },
      artifact_sha256,
      build_run_id,
      ci_run_id,
      environment,
      command,
      exit_code,
      output: { path: 'evidence/raw/M2-0026/lane.json', sha256: MAC_SHA }
    }
    expect(recordProblems(record)).toEqual([])
    expect(contentProblems(JSON.stringify(lane(0)), { account: 'runner' })).toEqual([])
  })

  it('reports a PRECONDITION with its reason as a warning that never reads as PASS', () => {
    const precondition = lane(2, '[fault-fatal-relaunch] No llama-server appeared within 120s')
    expect(precondition).toMatchObject({ exit_code: 2, outcome: 'PRECONDITION', report: null })
    expect(precondition.detail).toBe('[fault-fatal-relaunch] No llama-server appeared within 120s')
    expect(laneAnnotation(precondition)).toBe(
      '::warning title=fault-fatal-relaunch PRECONDITION (not PASS)::[fault-fatal-relaunch] No llama-server appeared within 120s'
    )
    const summary = laneSummary(precondition)
    expect(summary).toContain('### Candidate scenario fault-fatal-relaunch (mac): PRECONDITION')
    expect(summary).toContain('| outcome | `PRECONDITION` |')
    expect(summary).toContain('| detail | `[fault-fatal-relaunch] No llama-server appeared within 120s` |')
    expect(summary).not.toContain('PASS`')
    expect(laneAnnotation(lane(1, 'a survivor'))).toBe('::error title=fault-fatal-relaunch FAIL::a survivor')
    expect(laneAnnotation(lane(0))).toBeNull()
    expect(laneSummary(lane(0))).toContain('| build_run_id | `4242` |')
  })

  it('lists the rows the Windows reaper leg cannot prove as not covered, in lane.json and the summary', () => {
    const app = '../../_temp/candidate-install/Metis.exe'
    const winArgv = scenarioCommand({
      scenario: 'sidecar-boot-reaper',
      platform: 'win',
      installer: 'assets/Metis-Setup-1.0.0.exe',
      sha256: WIN_SHA,
      outDir: 'candidate-scenario',
      app
    })
    const win = laneRecord({
      scenario: 'sidecar-boot-reaper',
      platform: 'win',
      env: { GITHUB_RUN_ID: '5151', ImageOS: 'win25', ImageVersion: '20260920.1' },
      provenance,
      candidateRun: '4242',
      installer: 'assets/Metis-Setup-1.0.0.exe',
      sha256: WIN_SHA,
      argv: winArgv,
      exitCode: 0,
      detail: '',
      reportWritten: true
    })
    expect(win).toMatchObject({
      ticket: 'M2-0027',
      variant: 'win',
      installer: 'Metis-Setup-1.0.0.exe',
      environment: { kind: 'hosted-runner', host: 'windows-latest' },
      command: `node scripts/qa/sidecar-boot-reaper.mjs ${app} candidate-scenario/sidecar-boot-reaper.json`,
      outcome: 'PASS',
      report: 'sidecar-boot-reaper.json',
      not_covered: [
        { row: 'realLlama', reason: expect.stringMatching(/macOS only/) },
        { row: 'legacyOrphan', reason: expect.stringMatching(/macOS only/) }
      ]
    })
    const summary = laneSummary(win)
    expect(summary).toContain('| not covered: realLlama |')
    expect(summary).toContain('| not covered: legacyOrphan |')
    expect(contentProblems(JSON.stringify(win), { account: 'runneradmin' })).toEqual([])
    expect('not_covered' in lane(0)).toBe(false)
  })

  it('copies idle-soak acceptance fields from the report into lane.json', () => {
    const idleArgv = scenarioCommand({
      scenario: 'idle-soak',
      platform: 'mac',
      installer: 'assets/Metis-1.0.0.dmg',
      sha256: IDLE_SHA,
      outDir: 'candidate-scenario',
      app: 'candidate-install/Metis.app'
    })
    const lane = (laneRecord as any)({
      scenario: 'idle-soak',
      platform: 'mac',
      env,
      provenance,
      candidateRun: '4242',
      installer: 'assets/Metis-1.0.0.dmg',
      sha256: IDLE_SHA,
      argv: idleArgv,
      exitCode: 0,
      detail: '',
      reportWritten: true,
      reportData: {
        outcome: 'PASS',
        rule: { id: 'IDLE-GROWTH-1', rulesSha256: 'b'.repeat(64) },
        hoursMeasured: 5.49,
        parkedCoverage: 0.97,
        displayAwake: { recorded: true, command: 'caffeinate -d', pid: 123 },
        hostFloorOverride: true,
        hostMemory: { totalBytes: 7_516_192_768 },
        modelState: { llamaServerRan: false, sidecarSupervisorRan: false, note: 'llama-server never ran during the leg; the growth rule was still judged' }
      }
    })
    expect(lane).toMatchObject({
      scenario: 'idle-soak',
      ticket: 'M2-0492',
      variant: 'mac',
      artifact_sha256: IDLE_SHA,
      outcome: 'PASS',
      report: 'idle-soak.json',
      rule: { id: 'IDLE-GROWTH-1', rulesSha256: 'b'.repeat(64) },
      hoursMeasured: 5.49,
      parkedCoverage: 0.97,
      displayAwake: { recorded: true, command: 'caffeinate -d', pid: 123 },
      hostFloorOverride: true,
      hostMemory: { totalBytes: 7_516_192_768 },
      modelState: { llamaServerRan: false, sidecarSupervisorRan: false }
    })
    expect(contentProblems(JSON.stringify(lane), { account: 'runner' })).toEqual([])
  })

  it('uses the idle-soak report outcome so exit 1 can remain INCOMPLETE', () => {
    const lane = (laneRecord as any)({
      scenario: 'idle-soak',
      platform: 'mac',
      env,
      provenance,
      candidateRun: '4242',
      installer: 'assets/Metis-1.0.0.dmg',
      sha256: IDLE_SHA,
      argv: ['scripts/qa/soak/idle-soak.mjs'],
      exitCode: 1,
      detail: 'parked coverage below 95%',
      reportWritten: true,
      reportData: { outcome: 'INCOMPLETE', parkedCoverage: 0.9 }
    })
    expect(lane.outcome).toBe('INCOMPLETE')
    expect(lane.detail).toBe('parked coverage below 95%')
    expect(lane.parkedCoverage).toBe(0.9)
  })

  it('refuses a provenance from another run than candidate_run', () => {
    expect(() => assertCandidateProvenance(provenance, '4243')).toThrow(/not the candidate run 4243/)
    expect(() =>
      laneRecord({
        scenario: 'fault-fatal-relaunch',
        platform: 'mac',
        env,
        provenance,
        candidateRun: '1',
        installer: 'a.zip',
        sha256: MAC_SHA,
        argv,
        exitCode: 0,
        detail: '',
        reportWritten: true
      })
    ).toThrow(/not the candidate run 1/)
  })
})

describe('candidate-scenarios.mjs run', () => {
  // A repository-relative scratch directory: the lane refuses absolute paths in the recorded command.
  const scratch = join('out', `candidate-scenarios-test-${process.pid}`)
  afterEach(() => rmSync(join(root, scratch), { recursive: true, force: true }))

  it('runs the scenario, maps its PRECONDITION exit and writes lane.json with the reason', () => {
    mkdirSync(join(root, scratch, 'assets'), { recursive: true })
    writeFileSync(join(root, scratch, 'assets', 'Metis-QA-1.0.0.zip'), 'qa zip bytes')
    writeFileSync(join(root, scratch, 'provenance.json'), JSON.stringify({ commit: COMMIT, run: { id: 4242 } }))
    const outDir = `${scratch}/report`.replaceAll('\\', '/')
    // The named sha256 differs from the zip, so the proof stops at a precondition on every host: off macOS
    // before anything else, and on macOS at its own sha256 check. It never launches the app.
    const child = spawnSync(
      process.execPath,
      [
        'scripts/qa/candidate-scenarios.mjs',
        'run',
        '--scenario', 'fault-fatal-relaunch',
        '--platform', 'mac',
        '--installer', `${scratch}/assets/Metis-QA-1.0.0.zip`.replaceAll('\\', '/'),
        '--sha256', sha('other bytes'),
        '--provenance', join(scratch, 'provenance.json'),
        '--candidate-run', '4242',
        '--out', outDir
      ],
      { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '', GITHUB_RUN_ID: '5151' } }
    )
    expect(child.status).toBe(1)
    const lane = JSON.parse(readFileSync(join(root, outDir, 'lane.json'), 'utf8'))
    expect(lane).toMatchObject({ exit_code: 2, outcome: 'PRECONDITION', build_run_id: 4242, ci_run_id: 5151, report: null })
    expect(lane.detail).toMatch(/^\[fault-fatal-relaunch\] (This proof runs on macOS only\.|Zip sha256 mismatch)/)
    expect(child.stdout).toContain('::warning title=fault-fatal-relaunch PRECONDITION (not PASS)::')
  })

  it('passes ex-suite the installed app relative to the checkout and records its PRECONDITION report', () => {
    mkdirSync(join(root, scratch), { recursive: true })
    writeFileSync(join(root, scratch, 'provenance.json'), JSON.stringify({ commit: COMMIT, run: { id: 4242 } }))
    const outDir = `${scratch}/report`.replaceAll('\\', '/')
    // The installed app does not exist, so ex-suite stops at a precondition on every host (off macOS first,
    // on macOS at the bundle check) and never launches anything; it still writes its report.
    const child = spawnSync(
      process.execPath,
      [
        'scripts/qa/candidate-scenarios.mjs',
        'run',
        '--scenario', 'ex-suite',
        '--platform', 'mac',
        '--installer', `${scratch}/assets/Metis-1.0.0.dmg`.replaceAll('\\', '/'),
        '--sha256', MAC_SHA,
        '--provenance', join(scratch, 'provenance.json'),
        '--candidate-run', '4242',
        '--out', outDir,
        '--app', join(root, scratch, 'install', 'Metis.app')
      ],
      { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: '', GITHUB_RUN_ID: '5151' } }
    )
    expect(child.status).toBe(1)
    const lane = JSON.parse(readFileSync(join(root, outDir, 'lane.json'), 'utf8'))
    expect(lane).toMatchObject({ scenario: 'ex-suite', ticket: 'M2-0033', variant: 'mac', exit_code: 2, outcome: 'PRECONDITION', report: 'ex-suite.json' })
    expect(lane.command).toBe(
      `node scripts/qa/ex-suite.mjs --packaged ${scratch.replaceAll('\\', '/')}/install/Metis.app ${outDir}/ex-suite.json --relaunches 3`
    )
    expect(lane.detail).toMatch(/^\[ex-suite\] PRECONDITION: (The packaged EX suite runs on macOS only\.|The installed app is not a \.app bundle\.)/)
    const report = JSON.parse(readFileSync(join(root, outDir, 'ex-suite.json'), 'utf8'))
    expect(report).toMatchObject({ ticket: 'M2-0033', result: 'PRECONDITION', exitCode: 2, control: { status: 'BLOCKED_EXTERNAL' } })
  })
})
