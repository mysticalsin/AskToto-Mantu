import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { SCENARIOS } from './candidate-scenarios.mjs'
import {
  BUDGETS,
  EXIT_CODES,
  JOURNEY,
  JOURNEY_PROFILE_SETTINGS,
  JOURNEY_STEPS,
  JourneyPrecondition,
  QA_BUNDLE_ID,
  QA_WIN_EXECUTABLE,
  SAVED_MEETING,
  StepFailure,
  buildReport,
  contentFreeReport,
  isQaIdentity,
  journeyLaunchEnv,
  journeyPlan,
  judgeJourney,
  parseArgs,
  platformKey,
  reportContentProblems,
  runSteps,
  seedJourneyProfile,
  stepOrderProblems
} from './journey.mjs'
import { englishSentences } from './meeting/capture-wav.mjs'

type Result = { id: string; outcome: string; ms: number; reason?: string; facts?: object }

/** A clock that advances by `step` ms on every read, so each step's ms is deterministic. */
function fakeClock(step = 10) {
  let t = 1_000
  return () => (t += step)
}

const passingRunners = (calls: string[] = []) =>
  Object.fromEntries(
    JOURNEY_STEPS.map((id: string) => [
      id,
      async () => {
        calls.push(id)
        return { ran: true }
      }
    ])
  )

const pass = (id: string): Result => ({ id, outcome: 'PASS', ms: 5 })

describe('journey steps and order', () => {
  it('reads its scenario and budgets from the candidate-scenarios registry', () => {
    expect(JOURNEY).toBe(SCENARIOS.journey)
    expect(BUDGETS).toBe(SCENARIOS.journey.budgets)
    expect(JOURNEY_STEPS).toEqual(['onboarding', 'meeting', 'transcript', 'write-up'])
  })

  it('runs every step once, in order, and times each one', async () => {
    const calls: string[] = []
    const results = (await runSteps(journeyPlan('mac', passingRunners(calls)), { now: fakeClock(10) })) as Result[]
    expect(calls).toEqual(['onboarding', 'meeting', 'transcript', 'write-up'])
    expect(results.map((result) => [result.id, result.outcome, result.ms])).toEqual([
      ['onboarding', 'PASS', 10],
      ['meeting', 'PASS', 10],
      ['transcript', 'PASS', 10],
      ['write-up', 'PASS', 10]
    ])
    expect(stepOrderProblems(results)).toEqual([])
  })

  it('stops at the first failing step and reports the rest as NOT_RUN', async () => {
    const calls: string[] = []
    const runners = {
      ...passingRunners(calls),
      meeting: async () => {
        calls.push('meeting')
        throw new StepFailure('file-source-inactive', { listenMs: 90_000, fileSource: false })
      }
    }
    const results = (await runSteps(journeyPlan('mac', runners), { now: fakeClock(5) })) as Result[]
    expect(calls).toEqual(['onboarding', 'meeting'])
    expect(results.map((result) => result.outcome)).toEqual(['PASS', 'FAIL', 'NOT_RUN', 'NOT_RUN'])
    expect(results[1]).toEqual({ id: 'meeting', outcome: 'FAIL', ms: 5, reason: 'file-source-inactive', facts: { listenMs: 90_000, fileSource: false } })
    expect(results[2]).toEqual({ id: 'transcript', outcome: 'NOT_RUN', ms: 0 })
  })

  it('reports an unexpected error by its name only, never its message', async () => {
    const runners = {
      ...passingRunners(),
      onboarding: async () => {
        throw new TypeError('/Users/someone/Library/Application Support/asktoto-qa/settings.json')
      }
    }
    const results = (await runSteps(journeyPlan('mac', runners))) as Result[]
    expect(results[0]).toMatchObject({ id: 'onboarding', outcome: 'FAIL', reason: 'driver-error', facts: { error: 'TypeError' } })
    expect(JSON.stringify(results)).not.toContain('/Users/')
  })

  it('maps a precondition met inside a step to PRECONDITION', async () => {
    const runners = { ...passingRunners(), onboarding: async () => Promise.reject(new JourneyPrecondition('unsupported-host')) }
    const results = (await runSteps(journeyPlan('mac', runners))) as Result[]
    expect(results.map((result) => result.outcome)).toEqual(['PRECONDITION', 'NOT_RUN', 'NOT_RUN', 'NOT_RUN'])
    expect(judgeJourney(results)).toBe('PRECONDITION')
  })

  it('runs every step on Windows too, the file-fed meeting, transcript and write-up included, with none skipped', async () => {
    for (const platform of ['mac', 'win']) {
      expect('notCovered' in SCENARIOS.journey.platforms[platform as 'mac' | 'win']).toBe(false)
      const calls: string[] = []
      const results = (await runSteps(journeyPlan(platform, passingRunners(calls)), { now: fakeClock(10) })) as Result[]
      expect(calls).toEqual(['onboarding', 'meeting', 'transcript', 'write-up'])
      expect(results.map((result) => [result.id, result.outcome])).toEqual(JOURNEY_STEPS.map((id: string) => [id, 'PASS']))
      expect(judgeJourney(results)).toBe('PASS')
    }
    const calls: string[] = []
    const runners = {
      ...passingRunners(calls),
      meeting: async () => {
        calls.push('meeting')
        throw new StepFailure('file-source-inactive', { fileSource: false })
      }
    }
    const results = (await runSteps(journeyPlan('win', runners))) as Result[]
    expect(calls).toEqual(['onboarding', 'meeting'])
    expect(results.map((result) => result.outcome)).toEqual(['PASS', 'FAIL', 'NOT_RUN', 'NOT_RUN'])
    expect(judgeJourney(results)).toBe('FAIL')
  })

  it('drives only QA-identity bytes on both platforms: the promotable install is refused', () => {
    expect(isQaIdentity('mac', { executable: 'Metis QA.app/Contents/MacOS/Metis QA', bundleId: QA_BUNDLE_ID })).toBe(true)
    expect(isQaIdentity('mac', { executable: 'Metis.app/Contents/MacOS/Metis', bundleId: 'com.mantu.asktoto' })).toBe(false)
    expect(isQaIdentity('win', { executable: 'C:\\a\\_temp\\candidate-install\\Metis QA.exe' })).toBe(true)
    // The promotable Setup installs Metis.exe, which holds no file source.
    expect(isQaIdentity('win', { executable: 'C:\\a\\_temp\\candidate-install\\Metis.exe' })).toBe(false)
    expect(QA_WIN_EXECUTABLE).toBe('Metis QA.exe')
    expect(isQaIdentity('linux', { executable: 'Metis QA', bundleId: QA_BUNDLE_ID })).toBe(false)
  })

  it('refuses a platform the registry does not declare', () => {
    expect(() => journeyPlan('linux', passingRunners())).toThrow(JourneyPrecondition)
    expect(platformKey('darwin')).toBe('mac')
    expect(platformKey('win32')).toBe('win')
    expect(platformKey('linux')).toBeNull()
  })
})

describe('journey verdict and exit mapping', () => {
  it('uses the registry exits, which are fault-fatal-relaunch\'s: 0 PASS, 1 FAIL, 2 PRECONDITION', () => {
    expect(EXIT_CODES).toEqual({ PASS: 0, FAIL: 1, PRECONDITION: 2 })
    for (const [code, verdict] of Object.entries(SCENARIOS.journey.exits)) {
      expect(EXIT_CODES[verdict as keyof typeof EXIT_CODES]).toBe(Number(code))
    }
    expect(SCENARIOS.journey.exits).toEqual(SCENARIOS['fault-fatal-relaunch'].exits)
  })

  it('passes only when every step passed, in order', () => {
    expect(judgeJourney(JOURNEY_STEPS.map(pass))).toBe('PASS')
    const failed = JOURNEY_STEPS.map(pass)
    failed[3] = { id: 'write-up', outcome: 'FAIL', ms: 600_000 }
    expect(judgeJourney(failed)).toBe('FAIL')
    const notRun = JOURNEY_STEPS.map(pass)
    notRun[2] = { id: 'transcript', outcome: 'NOT_RUN', ms: 0 }
    expect(judgeJourney(notRun)).toBe('FAIL')
    expect(judgeJourney([...JOURNEY_STEPS].reverse().map(pass))).toBe('FAIL')
    expect(judgeJourney(JOURNEY_STEPS.slice(0, 3).map(pass))).toBe('FAIL')
    expect(stepOrderProblems(JOURNEY_STEPS.slice(0, 3).map(pass))).toHaveLength(1)
  })

  it('never passes a partial run: a skipped or blocked meeting step is a FAIL on Windows as on macOS', () => {
    const partial: Result[] = [pass('onboarding'), ...['meeting', 'transcript', 'write-up'].map((id) => ({ id, outcome: 'BLOCKED_EXTERNAL', ms: 0 }))]
    expect(judgeJourney(partial)).toBe('FAIL')
    expect(buildReport({ platform: 'win', results: partial })).toMatchObject({ verdict: 'FAIL', exitCode: 1 })
    expect(buildReport({ platform: 'mac', results: partial })).toMatchObject({ verdict: 'FAIL', exitCode: 1 })
    const nothingPassed = JOURNEY_STEPS.map((id: string) => ({ id, outcome: 'BLOCKED_EXTERNAL', ms: 0 }))
    expect(judgeJourney(nothingPassed)).toBe('FAIL')
    expect(buildReport({ platform: 'win', results: JOURNEY_STEPS.map(pass) })).toMatchObject({ verdict: 'PASS', exitCode: 0 })
  })

  it('is PRECONDITION, never PASS, when the installed bytes are not the QA identity', () => {
    const notRun = JOURNEY_STEPS.map((id: string) => ({ id, outcome: 'NOT_RUN', ms: 0 }))
    for (const platform of ['mac', 'win']) {
      expect(buildReport({ platform, results: notRun, precondition: 'not-qa-identity' })).toMatchObject({
        verdict: 'PRECONDITION',
        exitCode: 2,
        precondition: 'not-qa-identity'
      })
    }
  })

  it('is PRECONDITION when the journey could not start', () => {
    const notRun = JOURNEY_STEPS.map((id: string) => ({ id, outcome: 'NOT_RUN', ms: 0 }))
    expect(judgeJourney(notRun, { precondition: 'installer-sha256-mismatch' })).toBe('PRECONDITION')
    expect(buildReport({ platform: 'mac', results: notRun, precondition: 'installer-sha256-mismatch' })).toMatchObject({
      verdict: 'PRECONDITION',
      exitCode: 2,
      precondition: 'installer-sha256-mismatch'
    })
  })
})

describe('journey report', () => {
  const results: Result[] = [
    { id: 'onboarding', outcome: 'PASS', ms: 41_234.6, facts: { actions: 9, asrEngine: 'whisper', speechEngine: 'bundled', speechEngineReady: true } },
    { id: 'meeting', outcome: 'PASS', ms: 95_100, facts: { listenMs: 90_004, maxLiveLines: 7, stopped: true, fileSource: true, summarizer: 'local' } },
    { id: 'transcript', outcome: 'PASS', ms: 1_200, facts: { savedMeetings: 1, savedLines: 8, minLines: 3 } },
    { id: 'write-up', outcome: 'FAIL', ms: 600_000, reason: 'write-up-missing', facts: { recapStatus: null, recapNonEmpty: false, sinceStopMs: 600_000 } }
  ]

  it('lists every step with its outcome and whole milliseconds, plus the verdict, exit code and budgets', () => {
    const report = buildReport({ platform: 'mac', results })
    expect(Object.keys(report)).toEqual(['schema', 'scenario', 'ticket', 'platform', 'verdict', 'exitCode', 'budgets', 'steps'])
    expect(report).toMatchObject({ schema: 1, scenario: 'journey', ticket: 'M2-0524', platform: 'mac', verdict: 'FAIL', exitCode: 1 })
    expect(report.budgets).toEqual(SCENARIOS.journey.budgets)
    expect(report.steps.map((step: Result) => step.id)).toEqual(JOURNEY_STEPS)
    for (const step of report.steps) {
      expect(['PASS', 'FAIL', 'PRECONDITION', 'NOT_RUN', 'BLOCKED_EXTERNAL']).toContain(step.outcome)
      expect(Number.isInteger(step.ms)).toBe(true)
    }
    expect(report.steps[0].ms).toBe(41_235)
    expect(report.steps[3]).toMatchObject({ outcome: 'FAIL', reason: 'write-up-missing' })
  })

  it('is content-free: no user path, email or runner account, and none of the fed sentences', () => {
    const report = buildReport({ platform: 'mac', results })
    const scan = { account: 'runneradmin', forbidden: ['/private/var/folders/xy/T/metis-journey-abc', ...englishSentences()] }
    expect(reportContentProblems(JSON.stringify(report), scan)).toEqual([])
    expect(contentFreeReport(report, scan)).toBe(report)
    const windows = buildReport({ platform: 'win', results: results.map((result) => ({ ...result })) })
    expect(windows.steps.map((step: Result) => step.id)).toEqual(JOURNEY_STEPS)
    expect(reportContentProblems(JSON.stringify(windows), scan)).toEqual([])
  })

  it('names the rule a leaked value breaks, and replaces such a report with its step outcomes alone', () => {
    const sentence = englishSentences()[0]
    const scan = { account: 'runneradmin', forbidden: ['/private/var/folders/xy/T/metis-journey-abc', sentence] }
    expect(reportContentProblems(JSON.stringify({ facts: { line: sentence } }), scan)).toEqual(['forbidden literal'])
    expect(reportContentProblems('{"path":"/Users/someone/Métis Meetings/x.md"}', scan)).toEqual(['macOS user home path'])
    expect(reportContentProblems('{"path":"C:\\\\Users\\\\someone\\\\x.md"}', scan)).toEqual(['Windows user home path'])
    expect(reportContentProblems('{"who":"runneradmin"}', scan)).toEqual(['runner account name'])
    expect(reportContentProblems('{"mail":"someone@example.com"}', scan)).toEqual(['email address'])

    const leaky = buildReport({
      platform: 'mac',
      results: [{ ...results[0], facts: { title: sentence } }, ...results.slice(1)]
    })
    const written = contentFreeReport(leaky, scan)
    expect(written).toEqual({
      schema: 1,
      scenario: 'journey',
      ticket: 'M2-0524',
      platform: 'mac',
      verdict: 'FAIL',
      exitCode: 1,
      contentProblems: ['forbidden literal'],
      steps: leaky.steps.map(({ id, outcome, ms }: Result) => ({ id, outcome, ms }))
    })
    expect(reportContentProblems(JSON.stringify(written), scan)).toEqual([])
  })

  it('reads the saved meeting through the app as counts and a status name, never its text or title', async () => {
    const secretTitle = 'Quarterly plan with a named customer'
    const secretLine = englishSentences()[0]
    const window = {
      toto: {
        recallList: async () => [{ file: `2026-10-02_0900-${secretTitle}.md`, title: secretTitle }],
        recallRead: async (file: string) => ({
          ok: file.includes(secretTitle),
          title: secretTitle,
          recap: `## Decisions\n${secretLine}`,
          recapStatus: 'complete',
          lines: [{ text: secretLine }, { text: secretLine }, { text: secretLine }, { text: secretLine }]
        })
      }
    }
    const value = await runInNewContext(SAVED_MEETING, { window })
    expect(value).toEqual({ meetings: 1, lines: 4, recapStatus: 'complete', recapNonEmpty: true })
    expect(JSON.stringify(value)).not.toContain(secretTitle)
    const empty = await runInNewContext(SAVED_MEETING, { window: { toto: { recallList: async () => [] } } })
    expect(empty).toEqual({ meetings: 0, lines: 0, recapStatus: null, recapNonEmpty: false })
  })
})

describe('journey profile, launch and arguments', () => {
  it('seeds a fresh profile that is not onboarded, so the tour runs, with the local model able to write up', () => {
    const profile = mkdtempSync(join(tmpdir(), 'journey-test-'))
    try {
      seedJourneyProfile(profile)
      const settings = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'))
      expect(settings).toEqual(JOURNEY_PROFILE_SETTINGS)
      expect(settings.onboardingDone).toBe(false)
      expect(settings.localLlm).toMatchObject({ enabled: true, modelId: 'qwen3.5-0.8b', fallback: true, useFor: { summary: true, suggest: false } })
      expect(settings.asrEngine).toBe('whisper')
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  })

  it('launches on the isolated profile with no provider keys, and feeds the capture file only when given', () => {
    const base = { PATH: '/usr/bin', OPENAI_API_KEY: 'k', anthropic_api_key: 'k', METIS_QA_CAPTURE_FILE: '/elsewhere.wav' }
    const mac = journeyLaunchEnv(base, { profile: '/tmp/p', captureFile: '/tmp/p/qa-capture.wav' })
    expect(mac).toEqual({
      PATH: '/usr/bin',
      ASKTOTO_USERDATA: '/tmp/p',
      METIS_DISABLE_APPLE_FM: '1',
      METIS_QA_HOST_FLOOR_OVERRIDE: '1',
      METIS_QA_CAPTURE_FILE: '/tmp/p/qa-capture.wav'
    })
    const win = journeyLaunchEnv(base, { profile: 'C:\\t\\p' })
    expect(win).not.toHaveProperty('METIS_QA_CAPTURE_FILE')
    expect(win).not.toHaveProperty('OPENAI_API_KEY')
    expect(base.OPENAI_API_KEY).toBe('k')
  })

  it('takes exactly --app, --installer, --sha256 and --out, and treats anything else as a usage PRECONDITION', () => {
    const argv = ['--app', 'a.app', '--installer', 'assets/Metis-QA-1.0.0.zip', '--sha256', 'f'.repeat(64), '--out', 'candidate-scenario/journey.json']
    expect(parseArgs(argv)).toEqual({ app: 'a.app', installer: 'assets/Metis-QA-1.0.0.zip', sha256: 'f'.repeat(64), out: 'candidate-scenario/journey.json' })
    expect(() => parseArgs(argv.slice(0, 6))).toThrow(JourneyPrecondition)
    expect(() => parseArgs([...argv, '--port', '1'])).toThrow(/usage/)
    // The registry's own command is accepted as is.
    const command = SCENARIOS.journey.platforms.mac.args({ app: 'a.app', installer: 'i.zip', sha256: 'f'.repeat(64), report: 'r.json' })
    expect(parseArgs(command)).toEqual({ app: 'a.app', installer: 'i.zip', sha256: 'f'.repeat(64), out: 'r.json' })
  })
})
