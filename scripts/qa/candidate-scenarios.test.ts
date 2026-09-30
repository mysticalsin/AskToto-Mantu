import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    expect(Object.keys(SCENARIOS)).toEqual(['fault-fatal-relaunch'])
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

  it('requires the sha256 inputs a scenario needs and refuses any it does not use', () => {
    expect(resolveScenario({ scenario: 'fault-fatal-relaunch', sha256: { mac: ` ${MAC_SHA.toUpperCase()}\n`, win: '' } })).toEqual({
      mac: { variant: 'mac-qa-identity', artifact: 'candidate-mac-qa-identity', sha256: MAC_SHA }
    })
    expect(() => resolveScenario({ scenario: 'fault-fatal-relaunch', sha256: { mac: '' } })).toThrow(/mac_sha256 is required/)
    expect(() => resolveScenario({ scenario: 'fault-fatal-relaunch', sha256: { mac: 'v1.9.6' } })).toThrow(/mac_sha256 is required/)
    expect(() => resolveScenario({ scenario: 'fault-fatal-relaunch', sha256: { mac: MAC_SHA, win: MAC_SHA } })).toThrow(
      /win_sha256 is set, but fault-fatal-relaunch does not run on win/
    )
    expect(() => resolveScenario({ scenario: 'hk-m', sha256: { mac: MAC_SHA } })).toThrow(/Unknown scenario "hk-m"/)
    expect(() => resolveScenario({ scenario: 'toString', sha256: { mac: MAC_SHA } })).toThrow(/Unknown scenario/)
  })

  it('publishes one job switch per platform for the workflow', () => {
    const plan = resolveScenario({ scenario: 'fault-fatal-relaunch', sha256: { mac: MAC_SHA } })
    expect(resolveOutputs(plan)).toBe(
      `mac=true\nmac_variant=mac-qa-identity\nmac_artifact=candidate-mac-qa-identity\nmac_sha256=${MAC_SHA}\nwin=false\n`
    )
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

  it('refuses a QA userData directory that already exists', () => {
    mkdirSync(join(appData, 'asktoto-qa'))
    expect(() => prepareProfile({ scenario: 'fault-fatal-relaunch', platform: 'mac', appDataDir: appData })).toThrow(
      /asktoto-qa userData directory already exists/
    )
    expect(existsSync(join(appData, 'asktoto-qa', 'settings.json'))).toBe(false)
  })
})

describe('outcomeForExit', () => {
  it('maps 0 to PASS, 1 to FAIL and 2 to PRECONDITION; anything else is a FAIL', () => {
    expect(outcomeForExit('fault-fatal-relaunch', 0)).toBe('PASS')
    expect(outcomeForExit('fault-fatal-relaunch', 1)).toBe('FAIL')
    expect(outcomeForExit('fault-fatal-relaunch', 2)).toBe('PRECONDITION')
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
})
