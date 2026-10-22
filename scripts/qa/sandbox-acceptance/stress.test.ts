import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CASE_STEPS,
  MIB,
  MINUTE_MS,
  STRESS_CASES,
  bootMsFromAudit,
  caseTable,
  churnSequence,
  classifyAudit,
  classifyFolder,
  directoryBytes,
  expectedAfterClicks,
  findDuplicateMeetings,
  isStragglerFile,
  judgeKillRecovery,
  judgeOverlaySpam,
  judgeRelaunchLoop,
  judgeSettingsChurn,
  judgeSizes,
  judgeSpam,
  latencyProblems,
  looksIntact,
  parseCases,
  profileCensus,
  rssGrowth,
  seededRandom,
  spamGaps,
  stampOf,
  startupStats,
  stressSteps,
  summarizeLatency
} from './stress-lib.mjs'

const emptyFolder = {
  saved: [],
  drafts: [],
  stragglers: [],
  duplicates: { sameStamp: [], sameBytes: [] },
  otherNames: []
}

describe('case selection', () => {
  it('defaults to all eight cases in order and validates ids', () => {
    expect(parseCases(undefined)).toEqual([...STRESS_CASES])
    expect(parseCases('all')).toEqual([...STRESS_CASES])
    expect(parseCases('S3, s1')).toEqual(['s1', 's3'])
    expect(() => parseCases('s1,s9')).toThrow(/unknown stress case s9/)
  })

  it('plans install first, then each selected case, and every case has a step', () => {
    expect(stressSteps(['s1'])).toEqual(['install', 's1-start-stop-spam'])
    for (const id of STRESS_CASES) expect((CASE_STEPS as Record<string, string[]>)[id].length).toBeGreaterThan(0)
    expect(stressSteps().filter((id) => id !== 'install')).toHaveLength(Object.values(CASE_STEPS).flat().length)
  })
})

describe('click rhythm', () => {
  it('is reproducible and stays inside the requested gap range (S1 needs at most 300 ms)', () => {
    const a = spamGaps({ count: 20, minMs: 120, maxMs: 300, seed: 31 })
    expect(a).toEqual(spamGaps({ count: 20, minMs: 120, maxMs: 300, seed: 31 }))
    expect(a).toHaveLength(20)
    expect(Math.min(...a)).toBeGreaterThanOrEqual(120)
    expect(Math.max(...a)).toBeLessThanOrEqual(300)
    expect(spamGaps({ count: 20, minMs: 120, maxMs: 300, seed: 32 })).not.toEqual(a)
    const random = seededRandom(1)
    const value = random()
    expect(value).toBeGreaterThanOrEqual(0)
    expect(value).toBeLessThan(1)
  })
})

describe('renderer latency', () => {
  it('summarises answered probes and counts timeouts and slow answers against the limit', () => {
    const summary = summarizeLatency([{ ms: 5 }, { ms: 7 }, { ms: 2100 }, { ms: null, timedOut: true }], 2000)
    expect(summary).toMatchObject({
      probes: 4,
      answered: 3,
      timeouts: 1,
      overLimit: 1,
      maxMs: 2100,
      medianMs: 7,
      limitMs: 2000
    })
    expect(latencyProblems(summary).join(' ')).toMatch(
      /1 renderer probe\(s\) did not answer.*1 renderer probe\(s\) took 2000 ms or more/
    )
  })

  it('passes a fast run and refuses a run with no probes at all', () => {
    expect(latencyProblems(summarizeLatency([{ ms: 3 }, { ms: 9 }]))).toEqual([])
    expect(latencyProblems(summarizeLatency([])).join(' ')).toMatch(/no renderer responsiveness probe ran/)
    expect(summarizeLatency([]).maxMs).toBeNull()
  })
})

describe('audit classification', () => {
  const records = [
    { event: 'app.started', ts: '2026-10-21T10:00:00.000Z' },
    { event: 'app.renderer.ready', ts: '2026-10-21T10:00:02.500Z' },
    { event: 'app.crash' },
    { event: 'app.stall' },
    { event: 'app.stall' },
    { event: 'transcript.saved' }
  ]

  it('separates fatal events from notable ones by name only', () => {
    const result = classifyAudit(records)
    expect(result.fatal).toEqual({ 'app.crash': 1 })
    expect(result.notable).toEqual({ 'app.stall': 2 })
    expect((result.counts as Record<string, number>)['transcript.saved']).toBe(1)
  })

  it('measures boot time from the two audit timestamps, or null when one is missing', () => {
    expect(bootMsFromAudit(records)).toBe(2500)
    expect(bootMsFromAudit([{ event: 'app.started', ts: '2026-10-21T10:00:00.000Z' }])).toBeNull()
    expect(
      bootMsFromAudit([
        { event: 'app.started', ts: 'x' },
        { event: 'app.renderer.ready', ts: 'y' }
      ])
    ).toBeNull()
  })
})

describe('meeting files', () => {
  it('reads the start stamp, finds duplicates by stamp and by bytes, and flags partial writes', () => {
    expect(stampOf('2026-10-21_175748-4f45fde2b776.md')).toBe('2026-10-21_175748')
    expect(stampOf('README.md')).toBeNull()
    const duplicates = findDuplicateMeetings([
      { name: '2026-10-21_175748-aaa.md', sha256: '1' },
      { name: '2026-10-21_175748-bbb.md', sha256: '2' },
      { name: '2026-10-21_180000-ccc.md', sha256: '3' },
      { name: '2026-10-21_180100-ddd.md', sha256: '3' }
    ])
    expect(duplicates.sameStamp).toEqual([['2026-10-21_175748-aaa.md', '2026-10-21_175748-bbb.md']])
    expect(duplicates.sameBytes).toEqual([['2026-10-21_180000-ccc.md', '2026-10-21_180100-ddd.md']])
    expect(findDuplicateMeetings([{ name: 'a.md' }, { name: 'b.md' }])).toEqual({ sameStamp: [], sameBytes: [] })
    expect(isStragglerFile('2026-10-21_175748-aaa.md.0123456789abcdef01234567.tmp')).toBe(true)
    expect(isStragglerFile('.autosave-draft-2026-10-21_175748-123.md')).toBe(false)
    expect(isStragglerFile('2026-10-21_175748-aaa.md')).toBe(false)
  })

  it('accepts an encrypted or frontmatter head and rejects empty, NUL-filled and unknown files', () => {
    expect(looksIntact(Buffer.from('ATKENC2\n{"v"'), 100)).toBe(true)
    expect(looksIntact(Buffer.from('---\ntype: meeting-transcript'), 100)).toBe(true)
    expect(looksIntact(Buffer.alloc(8), 8)).toBe(false)
    expect(looksIntact(Buffer.from('ATKENC'), 0)).toBe(false)
    expect(looksIntact(Buffer.from('garbage'), 7)).toBe(false)
  })

  it('classifies a folder snapshot into saved files, drafts, partial writes and duplicates', () => {
    const folder = classifyFolder({
      saved: {
        '2026-10-21_175748-aaa.md': { sha256: '1', bytes: 10 },
        '2026-10-21_175748-bbb.md': { sha256: '2', bytes: 10 }
      },
      others: {
        '.autosave-draft-2026-10-21_175748-001.md': { sha256: '3', bytes: 5 },
        '2026-10-21_175748-aaa.md.abc.tmp': { sha256: '4', bytes: 1 },
        'README.md': { sha256: '5', bytes: 1 }
      }
    })
    expect(folder.saved).toHaveLength(2)
    expect(folder.drafts).toEqual(['.autosave-draft-2026-10-21_175748-001.md'])
    expect(folder.stragglers).toEqual(['2026-10-21_175748-aaa.md.abc.tmp'])
    expect(folder.duplicates.sameStamp).toHaveLength(1)
  })
})

describe('S1 verdict', () => {
  const good = {
    clicks: { planned: 20, start: 10, stop: 10, none: 0 },
    mainAlive: true,
    fatal: {},
    latency: summarizeLatency([{ ms: 4 }, { ms: 6 }]),
    settledIdle: true,
    stuck: false,
    liveTracks: 0,
    trackProbeEffective: true,
    folder: emptyFolder,
    unreadable: [],
    leftoverProcesses: 0
  }

  it('passes a clean run', () => expect(judgeSpam(good)).toEqual([]))

  it('names each way the app can fail the spam', () => {
    const problems = judgeSpam({
      ...good,
      clicks: { planned: 20, start: 2, stop: 1, none: 17 },
      mainAlive: false,
      fatal: { 'app.crash': 1 },
      latency: summarizeLatency([{ ms: null, timedOut: true }]),
      settledIdle: false,
      stuck: true,
      liveTracks: 2,
      folder: { ...emptyFolder, stragglers: ['a.tmp'], duplicates: { sameStamp: [['a', 'b']], sameBytes: [] } },
      unreadable: ['x.md'],
      leftoverProcesses: 3
    }).join(' | ')
    for (const part of [
      'only 3 of 20',
      'no longer running',
      '1 app.crash',
      'did not answer',
      'stuck',
      '2 audio track',
      'a.tmp',
      'duplicate',
      'x.md',
      '3 owned process'
    ])
      expect(problems).toContain(part)
  })

  it('does not judge orphan capture when the getUserMedia probe saw no call', () => {
    expect(judgeSpam({ ...good, liveTracks: 3, trackProbeEffective: false })).toEqual([])
  })
})

describe('S2 / S3 verdict', () => {
  const folder = { ...emptyFolder, saved: ['2026-10-21_175748-aaa.md'] }
  const good = {
    expectedMeetings: 1,
    folder,
    listed: 1,
    unreadable: [],
    minLines: 1,
    lines: 4,
    fatal: {},
    mainAlive: true
  }

  it('passes exactly one readable meeting with no leftovers', () => expect(judgeKillRecovery(good)).toEqual([]))

  it('fails zero, two, drafts left behind, partial writes, unreadable files and too few lines', () => {
    expect(judgeKillRecovery({ ...good, folder: emptyFolder, listed: 0 }).join(' ')).toMatch(
      /0 saved meeting file.*expected exactly 1.*lists 0/
    )
    expect(judgeKillRecovery({ ...good, folder: { ...folder, saved: ['a.md', 'b.md'] }, listed: 2 }).join(' ')).toMatch(
      /2 saved meeting file/
    )
    expect(judgeKillRecovery({ ...good, folder: { ...folder, drafts: ['.autosave-draft-x.md'] } }).join(' ')).toMatch(
      /1 autosave draft/
    )
    expect(judgeKillRecovery({ ...good, folder: { ...folder, stragglers: ['x.tmp'] } }).join(' ')).toMatch(
      /partial files/
    )
    expect(judgeKillRecovery({ ...good, unreadable: ['a.md'] }).join(' ')).toMatch(/corrupt/)
    expect(judgeKillRecovery({ ...good, lines: 0 }).join(' ')).toMatch(/0 transcript line/)
    expect(judgeKillRecovery({ ...good, fatal: { 'app.crash': 2 } }).join(' ')).toMatch(/2 app.crash/)
  })
})

describe('S4 verdict', () => {
  const cycle = (n: number, over: Record<string, unknown> = {}) => ({
    cycle: n,
    startupMs: 15000,
    bootMs: 600,
    clean: true,
    cleanRecord: true,
    leftovers: 0,
    prevShutdown: n === 1 ? 'unknown' : 'clean',
    files: 30,
    meetingEntries: 2,
    ownedProcesses: 9,
    fatal: {},
    ...over
  })
  const ten = (over: (n: number) => Record<string, unknown> = () => ({})) =>
    Array.from({ length: 10 }, (_, i) => cycle(i + 1, over(i + 1)))

  it('passes ten clean cycles with stable files and startup', () => {
    expect(judgeRelaunchLoop(ten())).toEqual([])
    expect(startupStats(ten())).toMatchObject({ count: 10, minMs: 15000, medianMs: 15000, maxMs: 15000 })
  })

  it('reports an unclean cycle, a missing clean record, a survivor and a wrong prevShutdown', () => {
    const problems = judgeRelaunchLoop(
      ten((n) =>
        n === 4 ? { clean: false, cleanRecord: false, leftovers: 2 } : n === 6 ? { prevShutdown: 'crash' } : {}
      )
    ).join(' | ')
    expect(problems).toMatch(/cycle 4: the app did not exit cleanly/)
    expect(problems).toMatch(/cycle 4: no app.shutdown.clean/)
    expect(problems).toMatch(/cycle 4: 2 owned process/)
    expect(problems).toMatch(/cycle 6: app.started reported prevShutdown "crash"/)
  })

  it('reports growth in files, meetings folder, processes and startup time', () => {
    const grown = ten((n) => ({
      files: 30 + n * 2,
      meetingEntries: n > 5 ? 3 : 2,
      ownedProcesses: 9 + n,
      startupMs: 15000 + n * 4000
    })).slice()
    const problems = judgeRelaunchLoop(grown).join(' | ')
    expect(problems).toMatch(/file count grew from 32 to 50/)
    expect(problems).toMatch(/meetings folder entries went from 2 to 3/)
    expect(problems).toMatch(/owned processes at ready grew/)
    expect(problems).toMatch(/startup slowed/)
    expect(judgeRelaunchLoop([])).toEqual(['no cycle completed'])
  })
})

describe('S6 settings churn', () => {
  it('builds the click order and the end state a landed click would produce', () => {
    const sequence = churnSequence({ count: 3, rounds: 2, extra: [0] })
    expect(sequence).toEqual([0, 1, 2, 0, 1, 2, 0])
    expect(expectedAfterClicks([false, true, false], sequence)).toEqual([true, true, false])
    expect(churnSequence({ count: 5, rounds: 50, extra: [0, 2, 4] })).toHaveLength(253)
  })

  const keys = ['a', 'b']
  const base = {
    keys,
    uiFinal: [true, false],
    mainFinal: [true, false],
    afterRelaunch: [true, false],
    paneAfterRelaunch: [true, false],
    expected: [true, false],
    settingsFile: { present: true, bytes: 311 },
    fatal: {},
    profileRecovered: 0
  }

  it('passes when every layer agrees, even if a rapid click was coalesced (reported, not failed)', () => {
    expect(judgeSettingsChurn(base)).toEqual({ problems: [], lostClicks: [] })
    const coalesced = judgeSettingsChurn({ ...base, expected: [true, true] })
    expect(coalesced.problems).toEqual([])
    expect(coalesced.lostClicks).toEqual(['b'])
  })

  it('fails on disagreement between the UI, main, a relaunch and the reopened pane, and on a reset profile', () => {
    const result = judgeSettingsChurn({
      ...base,
      uiFinal: [false, false],
      afterRelaunch: [true, true],
      paneAfterRelaunch: [true, false],
      settingsFile: { present: true, bytes: 0 },
      profileRecovered: 1,
      fatal: { 'app.crash': 1 }
    })
    const text = result.problems.join(' | ')
    expect(text).toMatch(/a: the switch showed false but main held true/)
    expect(text).toMatch(/b: false before the quit but true after the relaunch/)
    expect(text).toMatch(/b: the reopened pane shows false while settings hold true/)
    expect(text).toMatch(/settings.json is missing or empty/)
    expect(text).toMatch(/settings.profile_recovered/)
    expect(text).toMatch(/1 app.crash/)
  })
})

describe('S7 memory growth', () => {
  const series = (slopeMiBPerMin: number, minutes = 10, startMiB = 600, swingMiB = 0) =>
    Array.from({ length: minutes * 4 + 1 }, (_, i) => ({
      tMs: i * 15_000,
      rssBytes: (startMiB + slopeMiBPerMin * ((i * 15) / 60) + (i % 2 ? swingMiB : 0)) * MIB
    }))

  it('passes a flat series and reports the growth projected to an hour', () => {
    const result = rssGrowth(series(0), { settleMs: 2 * MINUTE_MS })
    expect(result).toMatchObject({ valid: true, pass: true, projectedMiBPerHour: 0, referenceMiB: 600, swingMiB: 0 })
  })

  it('fails growth beyond max(160 MiB, 20% of the reference) per projected hour', () => {
    const slow = rssGrowth(series(1), { settleMs: 2 * MINUTE_MS })
    expect(slow.projectedMiBPerHour).toBeCloseTo(60, 0)
    expect(slow.pass).toBe(true)
    const fast = rssGrowth(series(10), { settleMs: 2 * MINUTE_MS })
    expect(fast.projectedMiBPerHour).toBeCloseTo(600, 0)
    expect(fast.boundMiB).toBe(160)
    expect(fast.pass).toBe(false)
  })

  it('is not fooled by a sample-to-sample swing: it judges medians of thirds and reports the swing', () => {
    const swinging = rssGrowth(series(0, 10, 400, 700), { settleMs: 2 * MINUTE_MS })
    expect(swinging.swingMiB).toBe(700)
    expect(swinging.projectedMiBPerHour).toBeLessThan(5)
    expect(swinging.pass).toBe(true)
    expect(rssGrowth(series(10, 10, 400, 700), { settleMs: 2 * MINUTE_MS }).pass).toBe(false)
  })

  it('refuses to judge a series without a settle reference or enough later samples', () => {
    expect(rssGrowth([], { settleMs: 120_000 })).toMatchObject({ valid: false })
    expect(rssGrowth(series(0, 2).slice(0, 10), { settleMs: 120_000 })).toMatchObject({ valid: false })
  })

  it('bounds draft, saved and journal sizes and flags a draft that shrinks sharply', () => {
    expect(
      judgeSizes({ drafts: [{ bytes: 2000 }, { bytes: 9000 }], saved: [{ bytes: 20000 }], journalBytes: 0 })
    ).toEqual([])
    const text = judgeSizes({
      drafts: [{ bytes: 9000 }, { bytes: 100 }, { bytes: 3 * MIB }],
      saved: [{ bytes: 3 * MIB }],
      journalBytes: 30 * MIB
    }).join(' | ')
    expect(text).toMatch(/draft reached/)
    expect(text).toMatch(/saved meeting is/)
    expect(text).toMatch(/journal grew/)
    expect(text).toMatch(/shrank sharply/)
  })
})

describe('profile census', () => {
  let root: string
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'w14-stress-')))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('counts regular files outside Chromium caches and run markers, and reports the audit log separately', () => {
    mkdirSync(join(root, 'Cache'))
    writeFileSync(join(root, 'Cache', 'big'), 'x'.repeat(100))
    mkdirSync(join(root, 'logs'))
    writeFileSync(join(root, 'logs', 'audit.log'), 'abc')
    mkdirSync(join(root, 'Meetings'))
    writeFileSync(join(root, 'Meetings', 'a.md'), '12')
    writeFileSync(join(root, 'settings.json'), '1234')
    writeFileSync(join(root, 'run-alive.json'), '1')
    writeFileSync(join(root, 'crash-1.log'), 'c')
    const census = profileCensus(root)
    expect(census.files).toBe(3)
    expect(census.bytes).toBe(2 + 4 + 1)
    expect(census.auditBytes).toBe(3)
    expect(census.topLevel).toBe(6)
    expect(census.crashFiles).toEqual(['crash-1.log'])
  })

  it('sums a directory tree and returns 0 for a missing one', () => {
    mkdirSync(join(root, 'j', 'records'), { recursive: true })
    writeFileSync(join(root, 'j', 'm'), 'abc')
    writeFileSync(join(root, 'j', 'records', 'r'), 'de')
    expect(directoryBytes(join(root, 'j'))).toBe(5)
    expect(directoryBytes(join(root, 'missing'))).toBe(0)
  })
})

describe('S8 verdict and report table', () => {
  const good = {
    mainAlive: true,
    fatal: {},
    latency: summarizeLatency([{ ms: 4 }]),
    stuckModals: 0,
    barReachable: true,
    performed: 200
  }

  it('passes a surviving overlay with no stuck modal', () => expect(judgeOverlaySpam(good)).toEqual([]))

  it('fails a stuck modal, an unreachable bar, no clicks, and a dead app', () => {
    const text = judgeOverlaySpam({
      ...good,
      mainAlive: false,
      stuckModals: 2,
      barReachable: false,
      performed: 0
    }).join(' | ')
    expect(text).toMatch(/no longer running/)
    expect(text).toMatch(/2 modal/)
    expect(text).toMatch(/not reachable/)
    expect(text).toMatch(/no overlay control click/)
  })

  it('takes the worst step of each case, NOT_RUN for an unselected one', () => {
    const table = caseTable(
      [
        { id: 'install', status: 'PASS' },
        { id: 's1-start-stop-spam', status: 'PASS' },
        { id: 's2-kill9-mid-meeting', status: 'PASS' },
        { id: 's2-journal-tail', status: 'NOT_SUPPORTED' },
        { id: 's5-create-meetings', status: 'PASS' },
        { id: 's5-delete-confirm', status: 'NOT_SUPPORTED' },
        { id: 's5-search-works', status: 'FAIL' }
      ],
      ['s1', 's2', 's5', 's7']
    )
    expect(table.map((row) => [row.case, row.status])).toEqual([
      ['s1', 'PASS'],
      ['s2', 'NOT_SUPPORTED'],
      ['s5', 'FAIL'],
      ['s7', 'NOT_RUN']
    ])
  })
})
