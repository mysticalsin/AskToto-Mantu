import { describe, expect, it } from 'vitest'
import {
  CDP_READY_POLL_MS,
  CDP_READY_TIMEOUT_MS,
  DEFAULT_HOURS,
  EXIT_CODES,
  MIN_PARKED_COVERAGE,
  UPLOAD_RESERVE_MINUTES,
  classifySoakResult,
  exitCodeForOutcome,
  initialParkPreconditionError,
  jobSafeDeadlineEpochMs,
  launchEnv,
  soakSeconds,
  summarizeModelStateFromStream,
  waitForCdpVersion
} from './idle-soak.mjs'

describe('idle-soak deadline arithmetic', () => {
  it('leaves upload reserve inside a 355-minute hosted job while allowing the 5.5 h leg', () => {
    const jobStartedAtMs = Date.parse('2026-10-01T08:00:00.000Z')
    const deadline = jobSafeDeadlineEpochMs({ jobStartedAtMs, timeoutMinutes: 355 })
    expect(deadline - jobStartedAtMs).toBe((355 - UPLOAD_RESERVE_MINUTES) * 60_000)

    const afterSetup = jobStartedAtMs + 15 * 60_000
    expect(soakSeconds({ hours: DEFAULT_HOURS, nowMs: afterSetup, deadlineEpochMs: deadline })).toBe(330 * 60)
    const jobEndsAtMs = jobStartedAtMs + 355 * 60_000
    expect(jobEndsAtMs - (afterSetup + soakSeconds({ hours: DEFAULT_HOURS, nowMs: afterSetup, deadlineEpochMs: deadline }) * 1000)).toBe(
      UPLOAD_RESERVE_MINUTES * 60_000
    )
  })

  it('shortens the leg at the deadline instead of overrunning the upload window', () => {
    const nowMs = Date.parse('2026-10-01T08:00:00.000Z')
    expect(soakSeconds({ hours: DEFAULT_HOURS, nowMs, deadlineEpochMs: nowMs + 42_000 })).toBe(42)
    expect(soakSeconds({ hours: 1, nowMs })).toBe(3600)
    expect(() => soakSeconds({ hours: 6, nowMs })).toThrow(/at most 5.5/)
  })
})

describe('idle-soak outcome mapping', () => {
  it('maps PASS to 0 only when parked coverage meets the 95% floor', () => {
    expect(exitCodeForOutcome({ growthOutcome: 'PASS', parkedCoverage: MIN_PARKED_COVERAGE })).toBe(EXIT_CODES.PASS)
    expect(exitCodeForOutcome({ growthOutcome: 'PASS', parkedCoverage: 0.949 })).toBe(EXIT_CODES.FAIL_OR_INCOMPLETE)
  })

  it('maps growth FAIL or INCOMPLETE to 1 and launch/park preconditions to 2', () => {
    expect(exitCodeForOutcome({ growthOutcome: 'FAIL', parkedCoverage: 1 })).toBe(EXIT_CODES.FAIL_OR_INCOMPLETE)
    expect(exitCodeForOutcome({ growthOutcome: 'INCOMPLETE', parkedCoverage: 1 })).toBe(EXIT_CODES.FAIL_OR_INCOMPLETE)
    expect(exitCodeForOutcome({ launchPrecondition: true, growthOutcome: 'PASS', parkedCoverage: 1 })).toBe(EXIT_CODES.PRECONDITION)
    expect(exitCodeForOutcome({ parkPrecondition: true, growthOutcome: 'PASS', parkedCoverage: 1 })).toBe(EXIT_CODES.PRECONDITION)
  })

  it('keeps short growth legs and low parked coverage INCOMPLETE, never PASS', () => {
    expect(classifySoakResult({ censusExit: { code: 0, signal: null }, growthOutcome: 'INCOMPLETE', parkedCoverage: 1 })).toMatchObject({
      outcome: 'INCOMPLETE',
      exitCode: EXIT_CODES.FAIL_OR_INCOMPLETE
    })
    expect(classifySoakResult({ censusExit: { code: 0, signal: null }, growthOutcome: 'PASS', parkedCoverage: 0.94 })).toMatchObject({
      outcome: 'INCOMPLETE',
      exitCode: EXIT_CODES.FAIL_OR_INCOMPLETE,
      detail: expect.stringContaining('below')
    })
  })

  it('keeps census failures INCOMPLETE and preconditions as PRECONDITION', () => {
    expect(classifySoakResult({ censusExit: { code: 1, signal: null }, growthOutcome: 'PASS', parkedCoverage: 1 })).toMatchObject({
      outcome: 'INCOMPLETE',
      exitCode: EXIT_CODES.FAIL_OR_INCOMPLETE,
      detail: 'census exited 1'
    })
    expect(classifySoakResult({ censusExit: { code: null, signal: 'SIGTERM' }, growthOutcome: 'PASS', parkedCoverage: 1 })).toMatchObject({
      outcome: 'INCOMPLETE',
      exitCode: EXIT_CODES.FAIL_OR_INCOMPLETE,
      detail: 'census terminated by SIGTERM'
    })
    expect(classifySoakResult({ censusExit: { code: 2, signal: null }, growthOutcome: 'PASS', parkedCoverage: 1 })).toMatchObject({
      outcome: 'PRECONDITION',
      exitCode: EXIT_CODES.PRECONDITION
    })
  })

  it('maps a CDP readiness failure before the first park check to PRECONDITION', async () => {
    let now = 1_000
    const sleepFn = async <T = void>(ms = 0, value?: T): Promise<T> => {
      now += ms
      return value as T
    }
    await expect(
      waitForCdpVersion('http://127.0.0.1:1', {
        timeoutMs: CDP_READY_TIMEOUT_MS,
        pollMs: CDP_READY_POLL_MS,
        now: () => now,
        sleepFn,
        fetchFn: async () => {
          throw new Error('connection refused')
        }
      })
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.PRECONDITION, message: expect.stringContaining('/json/version') })
  })

  it('maps checker creation or first park-check failures to PRECONDITION', () => {
    expect(initialParkPreconditionError(new Error('connect failed'))).toMatchObject({
      exitCode: EXIT_CODES.PRECONDITION,
      message: 'the park could not be proven at start: connect failed'
    })
  })
})

describe('idle-soak launch environment and model state', () => {
  it('sets the host floor override for the app launch while dropping secret-looking variables', () => {
    const env = launchEnv(
      {
        PATH: '/usr/bin',
        OPENAI_API_KEY: 'redacted',
        GH_TOKEN: 'redacted',
        METIS_QA_HOST_FLOOR_OVERRIDE: '0'
      },
      'candidate-scenario/profile'
    )
    expect(env).toMatchObject({
      PATH: '/usr/bin',
      ASKTOTO_USERDATA: 'candidate-scenario/profile',
      METIS_QA_HOST_FLOOR_OVERRIDE: '1'
    })
    expect(env).not.toHaveProperty('OPENAI_API_KEY')
    expect(env).not.toHaveProperty('GH_TOKEN')
  })

  it('can launch without the override when explicitly disabled', () => {
    expect(launchEnv({}, 'profile', { hostFloorOverride: false })).toEqual({ ASKTOTO_USERDATA: 'profile' })
  })

  it('records whether llama-server and the sidecar-supervisor wrapper ran', () => {
    const line = (tMs: number, kind: string) =>
      JSON.stringify({ record: 'sample', tMs, processes: [{ pid: tMs + 1, startedMs: 1, kind }], mainAlive: true })
    expect(summarizeModelStateFromStream(`${line(0, 'main')}\n${line(30_000, 'llama-server')}\n${line(60_000, 'sidecar-supervisor')}\n`)).toMatchObject({
      llamaServerRan: true,
      sidecarSupervisorRan: true,
      sampleCount: 3,
      hoursMeasured: 60_000 / 3_600_000
    })
    expect(summarizeModelStateFromStream(`${line(0, 'main')}\n`)).toMatchObject({
      llamaServerRan: false,
      sidecarSupervisorRan: false
    })
  })
})
