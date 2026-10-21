import { describe, expect, it } from 'vitest'
import {
  CliError,
  EXIT_CODES,
  SINGLETON_SOCKET_SUFFIX,
  buildChildEnv,
  buildWav,
  checkSocketBudget,
  createReport,
  executableForApp,
  exitCodeForVerdict,
  finishReport,
  formatSteps,
  isDraftMeetingFile,
  isSavedMeetingFile,
  newRunId,
  parseCli,
  parseWavInfo,
  reportVerdict,
  runStep,
  sandboxLayout,
  seedSettings,
  shortTmpName
} from './lib.mjs'

const spec = {
  name: { type: 'string' },
  count: { type: 'number', default: 3, min: 1, max: 10 },
  'dry-run': { type: 'boolean', default: false },
  fast: { type: 'boolean', default: true }
} as const

describe('parseCli', () => {
  it('applies defaults and parses --flag value, --flag=value and booleans', () => {
    expect(parseCli([], spec)).toEqual({ count: 3, 'dry-run': false, fast: true })
    expect(parseCli(['--name', 'a', '--count=5', '--dry-run', '--no-fast'], spec)).toEqual({
      name: 'a',
      count: 5,
      'dry-run': true,
      fast: false
    })
  })

  it('rejects unknown flags, stray arguments, missing and bad values, and out-of-range numbers', () => {
    expect(() => parseCli(['--nope'], spec)).toThrow(CliError)
    expect(() => parseCli(['stray'], spec)).toThrow(/unexpected argument/)
    expect(() => parseCli(['--name'], spec)).toThrow(/needs a value/)
    expect(() => parseCli(['--name', '--count', '2'], spec)).toThrow(/needs a value/)
    expect(() => parseCli(['--count', 'abc'], spec)).toThrow(/needs a number/)
    expect(() => parseCli(['--count', ''], spec)).toThrow(/needs a number/)
    expect(() => parseCli(['--count', '0'], spec)).toThrow(/at least 1/)
    expect(() => parseCli(['--count', '11'], spec)).toThrow(/at most 10/)
    expect(() => parseCli(['--dry-run=maybe'], spec)).toThrow(/takes no value/)
  })
})

describe('sandbox layout', () => {
  const root = '/Users/x/Documents/Metis/_relay/goal-loop/sandbox-home'

  it('puts every run directory under the sandbox, outside the run-* directories isolate.sh prunes', () => {
    const layout = sandboxLayout({ sandboxRoot: root, runId: 'r1021-101500' })
    for (const path of [
      layout.home,
      layout.tmp,
      layout.userData,
      layout.meetingsFolder,
      layout.captureWav,
      layout.reportsDir,
      layout.appsDir,
      layout.auditLog
    ]) {
      expect(path.startsWith(`${root}/`)).toBe(true)
      expect(path).not.toMatch(/\/run-/)
    }
    expect(layout.meetingsFolder).toBe(`${layout.userData}/Métis Meetings`)
    expect(layout.captureWav.startsWith(`${layout.userData}/`)).toBe(true) // qa-capture-source needs the WAV inside the profile
    expect(layout.auditLog).toBe(`${layout.userData}/logs/audit.log`)
  })

  it('keeps TMPDIR short enough for the single-instance socket, and flags a root that is too deep', () => {
    const layout = sandboxLayout({ sandboxRoot: root, runId: 'r1021-101500' })
    expect(shortTmpName('r1021-101500')).toMatch(/^[0-9a-f]{4}$/)
    expect(checkSocketBudget(layout.tmp).ok).toBe(true)
    const deep = sandboxLayout({ sandboxRoot: `${root}/${'d'.repeat(40)}`, runId: 'r1' })
    const verdict = checkSocketBudget(deep.tmp)
    expect(verdict.ok).toBe(false)
    expect(verdict.detail).toContain('requestSingleInstanceLock')
    expect(Buffer.byteLength(layout.tmp + SINGLETON_SOCKET_SUFFIX)).toBeLessThanOrEqual(103)
  })

  it('makes short, safe run ids', () => {
    expect(newRunId(new Date(2026, 9, 21, 9, 5, 7))).toBe('r1021-090507')
  })
})

describe('child environment', () => {
  const layout = sandboxLayout({ sandboxRoot: '/s/_relay/goal-loop/sandbox-home', runId: 'r1' })

  it('is built from an allow-list, not copied from the harness', () => {
    const env = buildChildEnv({
      parentEnv: {
        PATH: '/usr/bin',
        LANG: 'en_US.UTF-8',
        SECRET_TOKEN: 't',
        HOME: '/Users/real',
        ASKTOTO_REQUIRE_AUTH: '1',
        METIS_QA_CAPTURE_FILE: '/real.wav'
      },
      layout,
      platform: 'darwin'
    })
    expect(env).toMatchObject({
      PATH: '/usr/bin',
      LANG: 'en_US.UTF-8',
      HOME: layout.home,
      TMPDIR: layout.tmp,
      ASKTOTO_USERDATA: layout.userData,
      ASKTOTO_LOCAL_KEYSTORE: '1'
    })
    expect(env.MAC_CHROMIUM_TMPDIR).toBe(layout.tmp)
    expect(env.CFFIXED_USER_HOME).toBe(layout.home)
    for (const key of ['SECRET_TOKEN', 'ASKTOTO_REQUIRE_AUTH', 'METIS_QA_CAPTURE_FILE'])
      expect(env).not.toHaveProperty(key)
  })

  it('sets METIS_QA_CAPTURE_FILE only when a capture file is given', () => {
    expect(
      buildChildEnv({ parentEnv: {}, layout, captureFile: layout.captureWav, platform: 'darwin' }).METIS_QA_CAPTURE_FILE
    ).toBe(layout.captureWav)
  })

  it('names the executable after the bundle, as electron-builder does', () => {
    expect(executableForApp('/s/Applications/Metis QA.app')).toBe(
      '/s/Applications/Metis QA.app/Contents/MacOS/Metis QA'
    )
  })

  it('seeds an onboarded, non-parked profile', () => {
    expect(seedSettings(5)).toEqual({
      onboardingDone: true,
      onboardingDoneAt: 5,
      overlayLayout: 'bar',
      autoHideOverlay: false
    })
  })
})

describe('synthetic WAV', () => {
  it('builds mono 16-bit PCM that its own parser accepts', () => {
    const wav = buildWav({ seconds: 2, sampleRate: 16_000 })
    const info = parseWavInfo(wav)
    expect(info).toMatchObject({ format: 1, channels: 1, sampleRate: 16_000, bitsPerSample: 16, dataBytes: 64_000 })
    expect(info?.durationSeconds).toBeCloseTo(2, 5)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
  })

  it('carries signal for tone bursts and none for silence', () => {
    const peak = (buffer: Buffer) => {
      let max = 0
      for (let i = 44; i + 1 < buffer.length; i += 2) max = Math.max(max, Math.abs(buffer.readInt16LE(i)))
      return max
    }
    expect(peak(buildWav({ seconds: 1, kind: 'tone-bursts' }))).toBeGreaterThan(1000)
    expect(peak(buildWav({ seconds: 1, kind: 'silence' }))).toBe(0)
  })

  it('rejects what Chromium fake capture would reject', () => {
    expect(parseWavInfo(Buffer.from('not a wav at all, definitely not a wav at all!!'))).toBeNull()
    const float = buildWav({ seconds: 1 })
    float.writeUInt16LE(3, 20) // IEEE float, not PCM
    expect(parseWavInfo(float)).toBeNull()
    const eightBit = buildWav({ seconds: 1 })
    eightBit.writeUInt16LE(8, 34)
    expect(parseWavInfo(eightBit)).toBeNull()
  })
})

describe('meeting files', () => {
  it('counts only saved meetings, never drafts, notes, the index or the README', () => {
    expect(isSavedMeetingFile('2026-10-21-1015-weekly-planning.md')).toBe(true)
    expect(isSavedMeetingFile('.autosave-draft-20261021-001.md')).toBe(false)
    expect(isSavedMeetingFile('README.md')).toBe(false)
    expect(isSavedMeetingFile('index.md')).toBe(false)
    expect(isSavedMeetingFile('2026-10-21-1015-note-abc.md')).toBe(false)
    expect(isSavedMeetingFile('picture.png')).toBe(false)
    expect(isDraftMeetingFile('.autosave-draft-20261021-001.md')).toBe(true)
    expect(isDraftMeetingFile('2026-10-21-1015-weekly.md')).toBe(false)
  })
})

describe('step report', () => {
  const clock = () => {
    let now = 1_000
    return () => (now += 5)
  }

  it('records a PASS only with evidence of an observation', async () => {
    const report = createReport({ tool: 't', now: clock() })
    await runStep(report, 'a', async () => ({ evidence: { seen: true } }))
    await runStep(report, 'b', async () => undefined)
    await runStep(report, 'c', async () => ({ evidence: {} }))
    await runStep(report, 'd', async () => ({ status: 'PASS' }))
    expect(report.steps.map((step) => [step.id, step.status])).toEqual([
      ['a', 'PASS'],
      ['b', 'FAIL'],
      ['c', 'FAIL'],
      ['d', 'FAIL']
    ])
    expect(report.steps[1]?.reason).toMatch(/no evidence/)
  })

  it('turns a throw into a FAIL carrying the message', async () => {
    const report = createReport({ tool: 't', now: clock() })
    const step = await runStep(report, 'x', async () => {
      throw new Error('boom')
    })
    expect(step).toMatchObject({ status: 'FAIL', reason: 'boom' })
  })

  it('requires a reason for any non-PASS status and rejects unknown statuses', async () => {
    const report = createReport({ tool: 't', now: clock() })
    expect((await runStep(report, 'n1', async () => ({ status: 'NOT_SUPPORTED' }))).status).toBe('FAIL')
    expect(
      await runStep(report, 'n2', async () => ({
        status: 'NOT_SUPPORTED',
        reason: 'tone is not speech',
        evidence: { audio: 'tone' }
      }))
    ).toMatchObject({ status: 'NOT_SUPPORTED', reason: 'tone is not speech' })
    expect((await runStep(report, 'n3', async () => ({ status: 'GREAT', evidence: { a: 1 } }))).status).toBe('FAIL')
  })

  it('skips a step whose prerequisites did not PASS, without running it', async () => {
    const report = createReport({ tool: 't', now: clock() })
    await runStep(report, 'first', async () => {
      throw new Error('no')
    })
    let ran = false
    const step = await runStep(
      report,
      'second',
      async () => {
        ran = true
        return { evidence: { a: 1 } }
      },
      { requires: ['first'] }
    )
    expect(ran).toBe(false)
    expect(step).toMatchObject({ status: 'SKIPPED', reason: 'requires first to PASS' })
    expect(
      (await runStep(report, 'third', async () => ({ evidence: { a: 1 } }), { requires: ['never-ran'] })).status
    ).toBe('SKIPPED')
  })

  it('derives the verdict and exit code', () => {
    expect(reportVerdict([])).toBe('INCOMPLETE')
    expect(reportVerdict([{ status: 'PASS' }, { status: 'PASS' }])).toBe('PASS')
    expect(reportVerdict([{ status: 'PASS' }, { status: 'NOT_SUPPORTED' }])).toBe('PASS_WITH_GAPS')
    expect(reportVerdict([{ status: 'PASS' }, { status: 'SKIPPED' }])).toBe('INCOMPLETE')
    expect(reportVerdict([{ status: 'SKIPPED' }, { status: 'FAIL' }, { status: 'NOT_SUPPORTED' }])).toBe('FAIL')
    expect(exitCodeForVerdict('PASS')).toBe(EXIT_CODES.PASS)
    expect(exitCodeForVerdict('PASS_WITH_GAPS')).toBe(EXIT_CODES.PASS)
    expect(exitCodeForVerdict('INCOMPLETE')).toBe(EXIT_CODES.FAIL)
    expect(exitCodeForVerdict('FAIL')).toBe(EXIT_CODES.FAIL)
  })

  it('finishes into a serialisable, content-free report', async () => {
    const report = createReport({
      tool: 'run-acceptance',
      config: { audio: 'speech' },
      meta: { bundleId: 'com.mantu.asktoto.qa' },
      now: clock()
    })
    await runStep(report, 'launch', async () => ({ evidence: { pid: 1 } }))
    const final = finishReport(report, { extra: true })
    expect(final).toMatchObject({
      schema: 'sandbox-acceptance/1',
      tool: 'run-acceptance',
      verdict: 'PASS',
      extra: true
    })
    expect(JSON.parse(JSON.stringify(final))).toEqual(final)
    expect(final).not.toHaveProperty('_now')
    expect(final.steps[0]?.ms).toBeGreaterThan(0)
    expect(formatSteps(final.steps)).toBe('[PASS] launch')
  })
})
