import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  FILES,
  INTERIM_STATUS,
  MIN_WORKING_DAYS,
  closureDirProblems,
  evaluateClosure,
  isOwnerChannelVersion,
  writeClosure
} from './closure.mjs'

// Ten active weekdays (2026-10-05..09 and 12..16), an active Saturday and an idle Sunday, all counts zero.
const FIXTURE = join(__dirname, 'fixtures', 'closure-summary.json')
const summary = (): any => JSON.parse(readFileSync(FIXTURE, 'utf8'))
const BOOT = '0f8fad5b-d9cb-469f-a165-70867728950e'
const bundle = (capturedAtMs: number, stalledMs = 6000): string => `${BOOT}.${capturedAtMs}.${stalledMs}.txt`
const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

function withSoak(overrides: { stallsOver5s?: number; revealNoOps?: number; afterUncleanExit?: number }): any {
  const s = summary()
  if (overrides.stallsOver5s !== undefined) s.scope.soak.stallsOver5s = overrides.stallsOver5s
  if (overrides.revealNoOps !== undefined) s.scope.soak.revealNoOps = overrides.revealNoOps
  if (overrides.afterUncleanExit !== undefined) s.scope.soak.orphanReaps.afterUncleanExit = overrides.afterUncleanExit
  return s
}

function acceptance(recordSha: string, decision = 'accept'): string {
  return [
    'evidence_level: ACCEPTED',
    'ticket: M2-0199',
    `decision: ${decision}`,
    'accepted_on: 2026-10-19',
    `closure_record_sha256: ${recordSha}`,
    ''
  ].join('\n')
}

let out: string
let work: string
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'm2-0199-closure-'))
  out = join(work, 'out')
})
afterEach(() => {
  rmSync(work, { recursive: true, force: true })
})

describe('owner-channel versions', () => {
  it('accepts 1.9.7, its hotfixes and later stable releases, and nothing else', () => {
    for (const v of ['1.9.7', '1.9.7-hotfix.1', '1.9.7-hotfix.12', '1.9.9', '1.9.10', '1.10.0', '2.0.0']) {
      expect(isOwnerChannelVersion(v), v).toBe(true)
    }
    for (const v of ['1.9.6', '1.9.8', '1.9.7-rc.1', '1.9.9-beta.2', '1.9.7-hotfix.0', '1.9.9-hotfix.1', '0.9.9', '', undefined]) {
      expect(isOwnerChannelVersion(v), String(v)).toBe(false)
    }
  })
})

describe('closure-rule-1', () => {
  it('closes after ten active weekdays with zero violations; an active weekend day does not count', () => {
    const result = evaluateClosure(summary())
    expect(result.problems).toEqual([])
    expect(result.days).toHaveLength(MIN_WORKING_DAYS)
    expect(result.days).not.toContain('2026-10-10')
    expect(result.reopens).toEqual([])
    expect(result.verdict).toBe('CLOSE')
  })

  it('is PENDING with nine working days and no violation', () => {
    const s = summary()
    delete s.scope.days['2026-10-16']
    expect(evaluateClosure(s).verdict).toBe('PENDING')
    s.scope.days['2026-10-16'] = { ...s.scope.days['2026-10-15'], records: 0 }
    expect(evaluateClosure(s).verdict).toBe('PENDING')
  })

  it('reopens B1 on a stall over 5 s or a reveal no-op, and B2 on an orphan after an unclean exit, however short the window', () => {
    expect(evaluateClosure(withSoak({ stallsOver5s: 1 }))).toMatchObject({ verdict: 'REOPEN', reopens: ['B1'] })
    expect(evaluateClosure(withSoak({ revealNoOps: 1 }))).toMatchObject({ verdict: 'REOPEN', reopens: ['B1'] })
    expect(evaluateClosure(withSoak({ afterUncleanExit: 1 }))).toMatchObject({ verdict: 'REOPEN', reopens: ['B2'] })
    const short = withSoak({ stallsOver5s: 2, afterUncleanExit: 1 })
    short.scope.days = { '2026-10-05': short.scope.days['2026-10-05'] }
    expect(evaluateClosure(short)).toMatchObject({ verdict: 'REOPEN', reopens: ['B1', 'B2'] })
  })

  it('counts an orphan reaped after a clean boot, or an unclean shutdown alone, as no violation', () => {
    const s = summary()
    s.scope.soak.orphanReaps.registry = 2
    s.scope.soak.uncleanShutdowns = 1
    expect(evaluateClosure(s).verdict).toBe('CLOSE')
  })

  it('refuses an ineligible summary: an older, beta or retired version, a version change, a truncated read or bad counts', () => {
    const problemsFor = (mutate: (s: any) => void): string[] => {
      const s = summary()
      mutate(s)
      return evaluateClosure(s).problems
    }
    for (const version of ['1.9.6', '1.9.9-beta.1', '1.9.8']) {
      expect(problemsFor((s) => { s.app.version = version; s.scope.version = version }).join('\n')).toMatch(/app\.version/)
    }
    expect(problemsFor((s) => { s.scope.version = '1.9.7-hotfix.1' }).join('\n')).toMatch(/scope\.version/)
    expect(problemsFor((s) => { s.window.truncated = true }).join('\n')).toMatch(/window\.truncated/)
    expect(problemsFor((s) => { s.scope.soak.revealNoOps = -1 }).join('\n')).toMatch(/reveal_no_ops/)
    expect(problemsFor((s) => { s.schema = 1 }).join('\n')).toMatch(/schema/)
    expect(evaluateClosure(null).problems).toEqual(['summary: expected a JSON object'])
  })

  it('refuses a summary whose per-day stalls or reveal no-ops exceed the soak totals, instead of closing on it', () => {
    const stalled = summary()
    stalled.scope.days['2026-10-07'].stallsOver5s = 1
    expect(evaluateClosure(stalled).verdict).toBeUndefined()
    expect(evaluateClosure(stalled).problems.join('\n')).toMatch(/stallsOver5s per day sum to 1, more than scope\.soak\.stallsOver5s \(0\)/)

    const noOp = summary()
    noOp.scope.days['2026-10-14'].revealNoOps = 2
    expect(evaluateClosure(noOp).verdict).toBeUndefined()
    expect(evaluateClosure(noOp).problems.join('\n')).toMatch(/revealNoOps per day sum to 2, more than scope\.soak\.revealNoOps \(0\)/)

    const malformed = summary()
    malformed.scope.days['2026-10-05'].revealNoOps = -1
    expect(evaluateClosure(malformed).problems.join('\n')).toMatch(/scope\.days\.2026-10-05\.revealNoOps/)

    // Consistent per-day evidence of a violation still reopens.
    const consistent = withSoak({ stallsOver5s: 1 })
    consistent.scope.days['2026-10-07'].stallsOver5s = 1
    expect(evaluateClosure(consistent)).toMatchObject({ problems: [], verdict: 'REOPEN', reopens: ['B1'] })
  })
})

describe('closure directory and the M2-0199 validator', () => {
  it('writes a CLOSE record with the interim wording that validates, and refuses fixed until the owner accepts that exact record', () => {
    expect(writeClosure({ summary: summary(), out }).verdict).toBe('CLOSE')
    expect(closureDirProblems(out)).toEqual([])
    const status = readFileSync(join(out, FILES.status), 'utf8')
    expect(status).toContain(`b1_status: ${INTERIM_STATUS.B1}`)
    expect(status).toContain(`b2_status: ${INTERIM_STATUS.B2}`)
    const recordSha = sha256(join(out, FILES.record))
    expect(readFileSync(join(out, FILES.leadAction), 'utf8')).toContain(`closure_record_sha256: ${recordSha}`)

    writeFileSync(join(out, FILES.status), 'b1_status: fixed\nb2_status: fixed\n')
    const refused = closureDirProblems(out)
    expect(refused.filter((p) => p.includes("may not say 'fixed'"))).toHaveLength(2)

    writeFileSync(join(out, FILES.acceptance), acceptance('0'.repeat(64)))
    expect(closureDirProblems(out).join('\n')).toMatch(/does not match closure-record\.md/)
    expect(closureDirProblems(out).join('\n')).toMatch(/may not say 'fixed'/)

    writeFileSync(join(out, FILES.acceptance), acceptance(recordSha, 'reject'))
    expect(closureDirProblems(out).filter((p) => p.includes("may not say 'fixed'"))).toHaveLength(2)

    writeFileSync(join(out, FILES.acceptance), acceptance(recordSha))
    expect(closureDirProblems(out)).toEqual([])
  })

  it('refuses fixed on a PENDING record even with an acceptance, and refuses any wording but the interim one', () => {
    const s = summary()
    delete s.scope.days['2026-10-16']
    writeClosure({ summary: s, out })
    expect(closureDirProblems(out)).toEqual([])
    writeFileSync(join(out, FILES.acceptance), acceptance(sha256(join(out, FILES.record))))
    writeFileSync(join(out, FILES.status), `b1_status: fixed\nb2_status: ${INTERIM_STATUS.B2}\n`)
    const problems = closureDirProblems(out).join('\n')
    expect(problems).toMatch(/can accept only a CLOSE verdict/)
    expect(problems).toMatch(/B1 may not say 'fixed'/)

    rmSync(join(out, FILES.acceptance))
    writeFileSync(join(out, FILES.status), `b1_status: fixed for the cause\nb2_status: ${INTERIM_STATUS.B2}\n`)
    expect(closureDirProblems(out).join('\n')).toMatch(/B1 must read 'fixed for the DERIVED cause'/)
  })

  it('on a violation attaches the in-scope sampled stall bundles from the export, writes a release/1.9.x hotfix stub and marks the bug reopened', () => {
    const exportDir = join(work, 'export')
    mkdirSync(exportDir)
    const inScope = bundle(1_791_000_000_000)
    const beforeScope = bundle(1_780_000_000_000)
    const pruned = bundle(1_791_000_000_500)
    const rows = [
      { ts: '2026-10-07T10:00:00.000Z', event: 'app.stall.sampled', bootId: BOOT, stalledMs: 6000, bundle: inScope },
      { ts: '2026-09-20T10:00:00.000Z', event: 'app.stall.sampled', bootId: BOOT, stalledMs: 6000, bundle: beforeScope },
      { ts: '2026-10-08T10:00:00.000Z', event: 'app.stall.sampled', bootId: BOOT, stalledMs: 7000, bundle: pruned },
      { ts: '2026-10-08T11:00:00.000Z', event: 'app.stall.sampled', bootId: BOOT, stalledMs: 7000, bundle: 'Thread 1 (main).txt' }
    ]
    writeFileSync(join(exportDir, 'audit.log'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\nnot json\n`)
    writeFileSync(join(exportDir, inScope), 'metis stall bundle v1\n')
    writeFileSync(join(exportDir, beforeScope), 'metis stall bundle v1\n')
    writeFileSync(join(exportDir, 'Thread 1 (main).txt'), 'x')

    expect(writeClosure({ summary: withSoak({ stallsOver5s: 1 }), exportDir, out }).verdict).toBe('REOPEN')
    const record = readFileSync(join(out, FILES.record), 'utf8')
    expect(record).toContain(`sampler_bundles: ${inScope}`)
    expect(record).toContain('reopens: B1')
    expect(record).toContain('diagnostics_export: attached')
    expect(readdirSync(join(out, FILES.stalls))).toEqual([inScope])
    const stub = readFileSync(join(out, FILES.hotfixStub), 'utf8')
    expect(stub).toContain('branch: release/1.9.x')
    expect(stub).toContain(inScope)
    expect(readFileSync(join(out, FILES.status), 'utf8')).toContain('b1_status: reopened')
    expect(readFileSync(join(out, FILES.status), 'utf8')).toContain(`b2_status: ${INTERIM_STATUS.B2}`)
    expect(closureDirProblems(out)).toEqual([])

    writeFileSync(join(out, FILES.status), `b1_status: ${INTERIM_STATUS.B1}\nb2_status: ${INTERIM_STATUS.B2}\n`)
    expect(closureDirProblems(out).join('\n')).toMatch(/B1 must be 'reopened'/)

    rmSync(join(out, FILES.stalls), { recursive: true })
    expect(closureDirProblems(out).join('\n')).toMatch(/named by the record but not attached/)
    rmSync(join(out, FILES.hotfixStub))
    expect(closureDirProblems(out).join('\n')).toMatch(/hotfix-ticket stub/)
  })

  it('refuses a REOPEN without the exported diagnostics bundle, a verdict the counts contradict, and a user path', () => {
    writeClosure({ summary: withSoak({ afterUncleanExit: 1 }), out })
    expect(readFileSync(join(out, FILES.status), 'utf8')).toContain('b2_status: reopened')
    expect(closureDirProblems(out).join('\n')).toMatch(/exported diagnostics bundle/)

    writeClosure({ summary: summary(), out })
    const recordPath = join(out, FILES.record)
    writeFileSync(recordPath, readFileSync(recordPath, 'utf8').replace('stalls_over_5s: 0', 'stalls_over_5s: 3'))
    expect(closureDirProblems(out).join('\n')).toMatch(/verdict CLOSE contradicts the counts/)

    writeClosure({ summary: summary(), out })
    writeFileSync(recordPath, `${readFileSync(recordPath, 'utf8')}note: /Users/someone/Library\n`)
    expect(closureDirProblems(out).join('\n')).toMatch(/user path or an email/)
  })

  it('reports a missing closure directory file by name', () => {
    expect(closureDirProblems(join(work, 'nothing')).join('\n')).toMatch(/closure-record\.md: missing/)
  })
})

describe('CLI', () => {
  const cli = join(__dirname, 'closure.mjs')
  const run = (args: string[]): ReturnType<typeof spawnSync> =>
    spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 60_000 })

  it('writes the closure directory from the fixture summary and exits 0', () => {
    const result = run(['--summary', FIXTURE, '--out', out])
    expect(result.status, String(result.stderr)).toBe(0)
    expect(String(result.stdout)).toMatch(/owner closure: CLOSE \(10 working days\)/)
    expect(closureDirProblems(out)).toEqual([])
  })

  it('exits 1 on an ineligible summary and 2 without --summary', () => {
    const bad = join(work, 'bad.json')
    writeFileSync(bad, JSON.stringify({ ...summary(), schema: 1 }))
    expect(run(['--summary', bad, '--out', out]).status).toBe(1)
    expect(run([]).status).toBe(2)
  })
})
