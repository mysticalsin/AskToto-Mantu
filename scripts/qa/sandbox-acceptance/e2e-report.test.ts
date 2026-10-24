import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bindReports, joinReports, main } from './e2e-report.mjs'

const map = JSON.parse(readFileSync(join(__dirname, 'capability-map.json'), 'utf8'))
const H = (char: string, length = 64) => char.repeat(length)
const binding = (over = {}) => ({
  commit: H('a', 40),
  run: { kind: 'local', runId: 'r1' },
  installerSha256: H('b'),
  appHash: H('c'),
  mainExecutableSha256: H('d'),
  bindingSource: 'local-asserted',
  ...over
})
const report = (scenario: string, steps: { id: string; status: string }[], over = {}) => ({
  config: { scenario },
  startedAt: '2026-10-24T10:00:00.000Z',
  meta: { binding: binding() },
  steps: steps.map((step) => ({ ...step, evidence: {} })),
  ...over
})
const capRow = (joined: ReturnType<typeof joinReports>, id: string) =>
  joined.capabilities.find((cap) => cap.id === id)?.rows
const caseRows = (joined: ReturnType<typeof joinReports>, id: string, letter: string) =>
  joined.e2e.find((entry) => entry.id === id && entry.case === letter)?.rows

describe('joinReports', () => {
  it('a missing report is NOT_RUN and static rows keep their own label', () => {
    const joined = joinReports(map, [])
    expect(capRow(joined, 'CAP-14')?.[0].status).toBe('NOT_RUN')
    expect(capRow(joined, 'CAP-12')?.[0].status).toBe('OWNER')
    expect(capRow(joined, 'CAP-30')?.[0].status).toBe('BLOCKED_EXTERNAL')
    expect(capRow(joined, 'CAP-01')?.[0].status).toBe('CI_ONLY')
    expect(caseRows(joined, 'E2E-04', 'H')?.[0].status).toBe('PENDING')
  })

  it('a NOT_SUPPORTED step stays NOT_SUPPORTED, and a PASS needs every named step to pass', () => {
    const steps = [
      { id: 'ma-assistant-propose-card', status: 'NOT_SUPPORTED' },
      { id: 'ma-assistant-idempotent', status: 'NOT_SUPPORTED' },
      { id: 'ma-persisted-after-relaunch', status: 'PASS' }
    ]
    const joined = joinReports(map, [report('memory-assistants', steps)])
    expect(capRow(joined, 'CAP-26')?.[0].status).toBe('NOT_SUPPORTED')
    expect(caseRows(joined, 'E2E-06', 'R')?.[0].status).toBe('PASS')
    const missingStep = joinReports(map, [
      report('memory-assistants', [{ id: 'ma-persisted-after-relaunch', status: 'PASS' }])
    ])
    expect(capRow(missingStep, 'CAP-26')?.[0].status).toBe('NOT_RUN')
  })

  it('a FAIL outranks a gap and a SKIPPED step is NOT_RUN', () => {
    const fail = joinReports(map, [
      report('settings-hig', [
        { id: 'settings-shortcut-opens', status: 'FAIL' },
        { id: 'settings-toggle-applies-without-save', status: 'NOT_SUPPORTED' }
      ])
    ])
    expect(capRow(fail, 'CAP-14')?.[0].status).toBe('FAIL')
    expect(fail.counts.FAIL).toBeGreaterThan(0)
    const skipped = joinReports(map, [
      report('quiet-mode', [
        { id: 'qm-policy-default', status: 'PASS' },
        { id: 'qm-unsolicited-held', status: 'SKIPPED' },
        { id: 'qm-direct-request-answered', status: 'PASS' },
        { id: 'qm-released-after-stop', status: 'PASS' }
      ])
    ])
    expect(capRow(skipped, 'CAP-32')?.[0].status).toBe('NOT_RUN')
  })

  it('owner rows print OWNER, never PASS, even when every report passes', () => {
    const everything = Object.entries({
      'voice-actions': [
        'va-default-on',
        'va-idle-no-mic',
        'va-short-hold-ignored',
        'va-read-only-immediate',
        'va-confirm-escape',
        'va-return-guard',
        'va-confirm-return-uncertain',
        'va-uncertain-reader-details'
      ]
    }).map(([scenario, ids]) =>
      report(
        scenario,
        ids.map((id) => ({ id, status: 'PASS' }))
      )
    )
    const joined = joinReports(map, everything)
    const rows = capRow(joined, 'CAP-16') ?? []
    expect(rows.map((row) => row.status)).toEqual(['PASS', 'OWNER'])
    expect(rows[1].target).toBe('LIVE_VERIFIED')
    for (const cap of joined.capabilities)
      for (const row of cap.rows) if (row.kind === 'owner-checklist') expect(row.status).toBe('OWNER')
  })

  it('uses the latest report of a scenario', () => {
    const old = report('settings-hig', [{ id: 'settings-shortcut-opens', status: 'FAIL' }], {
      startedAt: '2026-10-23T10:00:00.000Z'
    })
    const recent = report('settings-hig', [{ id: 'settings-shortcut-opens', status: 'PASS' }])
    const joined = joinReports(map, [recent, old])
    expect(joined.counts.FAIL ?? 0).toBe(0)
  })
})

describe('bindReports and the CLI', () => {
  it('refuses a report with no binding and reports that disagree', () => {
    const unbound = report('meeting', [], { meta: {} })
    expect(bindReports([unbound]).ok).toBe(false)
    const a = report('meeting', [])
    const b = report('settings-hig', [], { meta: { binding: binding({ commit: H('e', 40) }) } })
    expect(bindReports([a, b])).toEqual({ ok: false, problem: 'commit differs between reports' })
    expect(bindReports([a, report('upgrade', [])]).ok).toBe(true)
  })

  const files: Record<string, string> = {
    '/m.json': JSON.stringify(map),
    '/a.json': JSON.stringify(report('meeting', [{ id: 'transcript-observed', status: 'PASS' }])),
    '/b.json': JSON.stringify(report('settings-hig', [], { meta: { binding: binding({ installerSha256: H('9') }) } })),
    '/f.json': JSON.stringify(report('settings-hig', [{ id: 'settings-shortcut-opens', status: 'FAIL' }]))
  }
  const run = (argv: string[]) => {
    const out: string[] = []
    const err: string[] = []
    const code = main(argv, {
      read: (path: string) => {
        if (!(path in files)) throw new Error('ENOENT')
        return files[path]
      },
      out: (line: string) => out.push(line),
      err: (line: string) => err.push(line)
    })
    return { code, out: out.join('\n'), err: err.join('\n') }
  }

  it('mismatched bindings exit 2 and print no table', () => {
    const result = run(['/a.json', '/b.json', '--map', '/m.json'])
    expect(result.code).toBe(2)
    expect(result.err).toMatch(/installerSha256 differs/)
    expect(result.out).toBe('')
  })

  it('an unreadable report exits 2; a clean set prints the table and exits 0; a FAIL exits 1', () => {
    expect(run(['/missing.json', '--map', '/m.json']).code).toBe(2)
    const ok = run(['/a.json', '--map', '/m.json'])
    expect(ok.code).toBe(0)
    expect(ok.out).toMatch(/CAP-03 +PASS/)
    expect(ok.out).toMatch(/CAP-12 +OWNER/)
    expect(run(['/f.json', '--map', '/m.json']).code).toBe(1)
  })
})
