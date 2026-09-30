import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RECORD_SCHEMA, recordProblems } from './record.mjs'
import {
  TEST_WORKFLOW, ledgerProblems, loadProgram, outputProblems, prProblems, githubApi, m2_0008BundleProblems,
  m2_0194BundleProblems, releaseInputProblems, releaseProblems
} from './check.mjs'
import { drawSample, populationOf } from './sample.mjs'

const SHA1_A = '1'.repeat(40)
const SHA1_B = '2'.repeat(40)

const session = (id, model = 'claude-sonnet-5') => ({ model, id })

function ticket(overrides = {}) {
  return {
    id: 'M2-0001',
    status: 'TODO',
    type: 'feature',
    depends_on: [],
    needs_decision: [],
    kit_refs: [],
    finding_refs: [],
    slices: [],
    estimate_hours: 4,
    required_evidence: ['LOCALLY_TESTED'],
    external_blocker: null,
    flag: null,
    ...overrides
  }
}

const ledger = ({ tickets = [], decisions } = {}) => (decisions === undefined ? { tickets } : { tickets, decisions })

function record(overrides = {}) {
  return {
    schema: RECORD_SCHEMA,
    ticket: 'M2-0001',
    evidence_level: 'LOCALLY_TESTED',
    recorded_at: '2026-09-26T00:00:00Z',
    kit_refs: {},
    finding_refs: [],
    commit: SHA1_A,
    result: 'PASS',
    implementer_session: session('impl-1'),
    validator_session: session('valid-1'),
    pr: 42,
    ci_run_id: 101,
    environment: { kind: 'ci', host: 'ubuntu-latest' },
    command: 'npm test',
    exit_code: 0,
    ...overrides
  }
}

function assertProblem(problems, ...fragments) {
  const found = problems.some((p) => fragments.every((f) => p.includes(f)))
  assert.ok(found, `expected a problem containing ${JSON.stringify(fragments)} in ${JSON.stringify(problems)}`)
}

const noneMatching = (problems, fragment) => problems.some((p) => p.includes(fragment)) === false

test('C1 DONE with a PASS record per required level, ready deps and valid context has no problems', () => {
  const t = ticket({ id: 'M2-0001', status: 'DONE' })
  const recs = new Map([['M2-0001', [record()]]])
  assert.deepEqual(ledgerProblems(ledger({ tickets: [t] }), recs), [])
})

test('C2 DONE missing a required level names the ticket and the level', () => {
  const t = ticket({ id: 'M2-0001', status: 'DONE', required_evidence: ['LOCALLY_TESTED', 'MEASURED'] })
  const recs = new Map([['M2-0001', [record()]]])
  assertProblem(ledgerProblems(ledger({ tickets: [t] }), recs), 'M2-0001', 'DONE', 'MEASURED')
})

test('C3 latest record governs: a later FAIL withdraws an earlier PASS', () => {
  const t = ticket({ id: 'M2-0001', status: 'DONE' })
  const recs = new Map([['M2-0001', [record({ result: 'PASS' }), record({ result: 'FAIL', exit_code: 1 })]]])
  assertProblem(ledgerProblems(ledger({ tickets: [t] }), recs), 'M2-0001', 'DONE')
})

test('C4 required_evidence must be a non-empty, non-repeating array of known levels', () => {
  for (const required of [['VERIFIED'], ['LOCALLY_TESTED', 'LOCALLY_TESTED'], [], undefined]) {
    const t = ticket({ id: 'M2-0001', status: 'TODO', required_evidence: required })
    assertProblem(ledgerProblems(ledger({ tickets: [t] }), new Map()), 'M2-0001')
  }
})

test('C5 an unknown status is a problem', () => {
  const t = ticket({ id: 'M2-0001', status: 'READY' })
  assertProblem(ledgerProblems(ledger({ tickets: [t] }), new Map()), 'M2-0001', 'status')
})

test('C6 IN_PROGRESS requires every dependency to be ready', () => {
  const notReadyDep = ticket({ id: 'M2-0002', status: 'TODO' })
  const t = ticket({ id: 'M2-0001', status: 'IN_PROGRESS', depends_on: ['M2-0002'] })
  assertProblem(ledgerProblems(ledger({ tickets: [t, notReadyDep] }), new Map()), 'M2-0001', 'not ready')

  for (const status of ['ENGINEERING_COMPLETE', 'DONE', 'DEFERRED', 'BLOCKED_EXTERNAL']) {
    const readyDep = ticket({ id: 'M2-0002', status })
    const problems = ledgerProblems(ledger({ tickets: [t, readyDep] }), new Map())
    assert.equal(problems.some((p) => p.startsWith('M2-0001:') && p.includes('not ready')), false)
  }
})

test('C7 IN_PROGRESS over 12h needs slices of at most 10h each', () => {
  const noSlices = ticket({ id: 'M2-0001', status: 'IN_PROGRESS', estimate_hours: 14, slices: [] })
  assertProblem(ledgerProblems(ledger({ tickets: [noSlices] }), new Map()), 'M2-0001', 'slices')

  const oneTooLong = ticket({ id: 'M2-0001', status: 'IN_PROGRESS', estimate_hours: 14, slices: [{ id: 'a', estimate_hours: 11 }] })
  assertProblem(ledgerProblems(ledger({ tickets: [oneTooLong] }), new Map()), 'M2-0001', '10h')

  const goodSlices = ticket({
    id: 'M2-0001', status: 'IN_PROGRESS', estimate_hours: 14,
    slices: [{ id: 'a', estimate_hours: 8 }, { id: 'b', estimate_hours: 6 }]
  })
  assert.ok(noneMatching(ledgerProblems(ledger({ tickets: [goodSlices] }), new Map()), 'slice'))

  const exactlyTwelve = ticket({ id: 'M2-0001', status: 'IN_PROGRESS', estimate_hours: 12, slices: [] })
  assert.ok(noneMatching(ledgerProblems(ledger({ tickets: [exactlyTwelve] }), new Map()), 'slice'))
})

test('C8 DONE directly downstream of BLOCKED_EXTERNAL can close only as ENGINEERING_COMPLETE', () => {
  const blocker = ticket({
    id: 'M2-0001', status: 'BLOCKED_EXTERNAL',
    external_blocker: { owner: 'o', unblock_step: 'u', needed_by: '2026-10-01', raised_on: '2026-09-01' }
  })
  const t = ticket({ id: 'M2-0002', status: 'DONE', depends_on: ['M2-0001'] })
  const recs = new Map([['M2-0002', [record({ ticket: 'M2-0002', inherited_block: [{ ticket: 'M2-0001', unblock_step: 'u' }] })]]])
  assertProblem(ledgerProblems(ledger({ tickets: [blocker, t] }), recs), 'M2-0002', 'only as ENGINEERING_COMPLETE')
})

test('C9 a transitive ENGINEERING_COMPLETE/BLOCKED_EXTERNAL ancestor caps a DONE ticket', () => {
  const a = ticket({
    id: 'M2-0001', status: 'BLOCKED_EXTERNAL',
    external_blocker: { owner: 'o', unblock_step: 'u', needed_by: '2026-10-01', raised_on: '2026-09-01' }
  })
  const b = ticket({ id: 'M2-0002', status: 'ENGINEERING_COMPLETE', depends_on: ['M2-0001'] })
  const c = ticket({ id: 'M2-0003', status: 'DONE', depends_on: ['M2-0002'] })
  const recs = new Map([
    ['M2-0002', [record({ ticket: 'M2-0002', inherited_block: [{ ticket: 'M2-0001', unblock_step: 'u' }] })]],
    ['M2-0003', [record({ ticket: 'M2-0003' })]]
  ])
  assertProblem(ledgerProblems(ledger({ tickets: [a, b, c] }), recs), 'M2-0003', 'only as ENGINEERING_COMPLETE')
})

test('C10 ENGINEERING_COMPLETE downstream of a blocked ancestor must list it in inherited_block', () => {
  const blocker = ticket({
    id: 'M2-0001', status: 'BLOCKED_EXTERNAL',
    external_blocker: { owner: 'o', unblock_step: 'unblock A', needed_by: '2026-10-01', raised_on: '2026-09-01' }
  })
  const t = ticket({ id: 'M2-0002', status: 'ENGINEERING_COMPLETE', depends_on: ['M2-0001'] })

  const noBlockRecord = new Map([['M2-0002', [record({ ticket: 'M2-0002' })]]])
  assertProblem(ledgerProblems(ledger({ tickets: [blocker, t] }), noBlockRecord), 'M2-0002', 'inherited_block', 'M2-0001')

  const withBlockRecord = new Map([
    ['M2-0002', [record({ ticket: 'M2-0002', inherited_block: [{ ticket: 'M2-0001', unblock_step: 'unblock A' }] })]]
  ])
  assert.ok(noneMatching(ledgerProblems(ledger({ tickets: [blocker, t] }), withBlockRecord), 'inherited_block'))
})

test('C11 ENGINEERING_COMPLETE with no external blocker and no capping ancestor is a problem', () => {
  const t = ticket({ id: 'M2-0001', status: 'ENGINEERING_COMPLETE' })
  const recs = new Map([['M2-0001', [record({ ticket: 'M2-0001' })]]])
  assertProblem(ledgerProblems(ledger({ tickets: [t] }), recs), 'M2-0001', 'external blocker')
})

test('C12 a DONE ticket must drop inherited_block once the upstream is DONE', () => {
  const upstream = ticket({ id: 'M2-0001', status: 'DONE' })
  const downstream = ticket({ id: 'M2-0002', status: 'DONE', depends_on: ['M2-0001'] })
  const stale = record({ ticket: 'M2-0002', inherited_block: [{ ticket: 'M2-0001', unblock_step: 'x' }] })
  const recs = new Map([['M2-0001', [record({ ticket: 'M2-0001' })]], ['M2-0002', [stale]]])
  assertProblem(ledgerProblems(ledger({ tickets: [upstream, downstream] }), recs), 'M2-0002', 'inherited_block')

  const clean = record({ ticket: 'M2-0002', ci_run_id: 202 })
  const cleanRecs = new Map([['M2-0001', [record({ ticket: 'M2-0001' })]], ['M2-0002', [stale, clean]]])
  assert.ok(noneMatching(ledgerProblems(ledger({ tickets: [upstream, downstream] }), cleanRecs), 'inherited_block'))
})

test('C13 closes_program DONE must list every capping root; only one ticket may set the flag', () => {
  const blockerA = ticket({
    id: 'M2-0001', status: 'BLOCKED_EXTERNAL',
    external_blocker: { owner: 'o', unblock_step: 'u1', needed_by: '2026-10-01', raised_on: '2026-09-01' }
  })
  const blockerB = ticket({
    id: 'M2-0002', status: 'BLOCKED_EXTERNAL',
    external_blocker: { owner: 'o', unblock_step: 'u2', needed_by: '2026-10-01', raised_on: '2026-09-01' }
  })
  const closer = ticket({ id: 'M2-0003', status: 'DONE', closes_program: true, depends_on: ['M2-0001', 'M2-0002'] })

  const missingOne = new Map([['M2-0003', [record({ ticket: 'M2-0003', inherited_block: [{ ticket: 'M2-0001', unblock_step: 'u1' }] })]]])
  assertProblem(ledgerProblems(ledger({ tickets: [blockerA, blockerB, closer] }), missingOne), 'M2-0003', 'M2-0002')

  const both = new Map([['M2-0003', [record({
    ticket: 'M2-0003',
    inherited_block: [{ ticket: 'M2-0001', unblock_step: 'u1' }, { ticket: 'M2-0002', unblock_step: 'u2' }]
  })]]])
  assert.ok(noneMatching(ledgerProblems(ledger({ tickets: [blockerA, blockerB, closer] }), both), 'inherited_block'))

  const secondCloser = ticket({ id: 'M2-0004', status: 'TODO', closes_program: true })
  assertProblem(ledgerProblems(ledger({ tickets: [blockerA, blockerB, closer, secondCloser] }), both), 'at most one ticket')
})

test('C14 a closed fix ticket needs repro on its LOCALLY_TESTED record; a MEASURED-only fix does not', () => {
  const t = ticket({ id: 'M2-0001', status: 'DONE', type: 'fix', required_evidence: ['LOCALLY_TESTED'] })
  const noRepro = new Map([['M2-0001', [record({ ticket: 'M2-0001' })]]])
  assertProblem(ledgerProblems(ledger({ tickets: [t] }), noRepro), 'M2-0001', 'repro')

  const withRepro = new Map([
    ['M2-0001', [record({ ticket: 'M2-0001', repro: { test: 'scripts/evidence/check.test.mjs', commit: SHA1_B, ci_run_id: 55 } })]]
  ])
  assert.ok(noneMatching(ledgerProblems(ledger({ tickets: [t] }), withRepro), 'repro'))

  const measuredFix = ticket({ id: 'M2-0002', status: 'DONE', type: 'fix', required_evidence: ['MEASURED'] })
  const measuredRecs = new Map([['M2-0002', [record({
    ticket: 'M2-0002', evidence_level: 'MEASURED', environment: { kind: 'ci', host: 'ubuntu-latest' },
    output: { path: 'evidence/x.json', sha256: 'a'.repeat(64) }, pr: undefined, ci_run_id: undefined
  })]]])
  assert.ok(noneMatching(ledgerProblems(ledger({ tickets: [measuredFix] }), measuredRecs), 'repro'))
})

test('C15 a record kit_refs set must equal the ticket kit_refs exactly', () => {
  const t = ticket({ id: 'M2-0001', status: 'IN_PROGRESS', kit_refs: ['F-18', 'FLOW-12'] })
  const missing = new Map([['M2-0001', [record({ ticket: 'M2-0001', kit_refs: { 'F-18': 'PARTIAL' } })]]])
  assertProblem(ledgerProblems(ledger({ tickets: [t] }), missing), 'M2-0001', 'kit_refs')

  const extra = new Map([['M2-0001', [record({
    ticket: 'M2-0001', kit_refs: { 'F-18': 'PARTIAL', 'FLOW-12': 'PARTIAL', EXTRA: 'MET' }
  })]]])
  assertProblem(ledgerProblems(ledger({ tickets: [t] }), extra), 'M2-0001', 'kit_refs')

  const exact = new Map([['M2-0001', [record({ ticket: 'M2-0001', kit_refs: { 'F-18': 'PARTIAL', 'FLOW-12': 'PARTIAL' } })]]])
  assert.ok(noneMatching(ledgerProblems(ledger({ tickets: [t] }), exact), 'kit_refs'))
})

test('C16 a finding_ref not on the ticket is a problem', () => {
  const t = ticket({ id: 'M2-0001', status: 'IN_PROGRESS', finding_refs: ['PUBLIC-A10'] })
  const recs = new Map([['M2-0001', [record({ ticket: 'M2-0001', finding_refs: ['PUBLIC-A10', 'PUBLIC-A99'] })]]])
  assertProblem(ledgerProblems(ledger({ tickets: [t] }), recs), 'M2-0001', 'PUBLIC-A99')
})

test('C17 unlabelled OPEN assumptions and answered-changed decisions must be flagged', () => {
  const t = ticket({ id: 'M2-0001', status: 'DONE', needs_decision: ['D-13'] })
  const unlabelled = new Map([['M2-0001', [record({ ticket: 'M2-0001' })]]])
  assertProblem(
    ledgerProblems(ledger({ tickets: [t], decisions: { 'D-13': 'OPEN' } }), unlabelled),
    'M2-0001', 'unlabelled assumption'
  )

  const labelled = new Map([['M2-0001', [record({ ticket: 'M2-0001', assumed_decisions: ['D-13'] })]]])
  assert.ok(noneMatching(ledgerProblems(ledger({ tickets: [t], decisions: { 'D-13': 'OPEN' } }), labelled), 'unlabelled'))

  assertProblem(
    ledgerProblems(ledger({ tickets: [t], decisions: { 'D-13': 'ANSWERED_CHANGED' } }), labelled),
    'M2-0001', 're-validate', 'D-13'
  )
  assert.ok(
    noneMatching(ledgerProblems(ledger({ tickets: [t], decisions: { 'D-13': 'ANSWERED_AS_DEFAULT' } }), labelled), 're-validate')
  )

  assertProblem(ledgerProblems(ledger({ tickets: [t], decisions: {} }), labelled), 'D-13')
  assertProblem(ledgerProblems(ledger({ tickets: [t] }), labelled), 'decisions register')
})

test('C18 DEFERRED requires a non-null flag and an ACCEPTED PASS record', () => {
  const noFlag = ticket({ id: 'M2-0001', status: 'DEFERRED', required_evidence: ['ACCEPTED'] })
  assertProblem(ledgerProblems(ledger({ tickets: [noFlag] }), new Map()), 'M2-0001', 'flag')

  const flagNoAccept = ticket({ id: 'M2-0002', status: 'DEFERRED', flag: 'my-flag', required_evidence: ['ACCEPTED'] })
  assertProblem(ledgerProblems(ledger({ tickets: [flagNoAccept] }), new Map()), 'M2-0002', 'ACCEPTED')

  const both = ticket({ id: 'M2-0003', status: 'DEFERRED', flag: 'my-flag', required_evidence: ['ACCEPTED'] })
  const recs = new Map([['M2-0003', [record({
    ticket: 'M2-0003', evidence_level: 'ACCEPTED',
    owner_statement: { date: '2026-09-01', text: 'approved' },
    pr: undefined, ci_run_id: undefined, environment: undefined, command: undefined, exit_code: undefined
  })]]])
  const problems = ledgerProblems(ledger({ tickets: [both] }), recs).filter((p) => p.startsWith('M2-0003:'))
  assert.deepEqual(problems, [])
})

test('C19 CANCELLED requires a non-empty reason', () => {
  const t = ticket({ id: 'M2-0001', status: 'CANCELLED' })
  assertProblem(ledgerProblems(ledger({ tickets: [t] }), new Map()), 'M2-0001', 'reason')

  const withReason = ticket({ id: 'M2-0002', status: 'CANCELLED', reason: 'superseded by M2-0099' })
  const problems = ledgerProblems(ledger({ tickets: [withReason] }), new Map()).filter((p) => p.startsWith('M2-0002:'))
  assert.deepEqual(problems, [])
})

test('C20 BLOCKED_EXTERNAL requires a complete external_blocker', () => {
  const nullBlocker = ticket({ id: 'M2-0001', status: 'BLOCKED_EXTERNAL', external_blocker: null })
  assertProblem(ledgerProblems(ledger({ tickets: [nullBlocker] }), new Map()), 'M2-0001', 'BLOCKED_EXTERNAL')

  const missingStep = ticket({
    id: 'M2-0002', status: 'BLOCKED_EXTERNAL',
    external_blocker: { owner: 'o', needed_by: '2026-10-01', raised_on: '2026-09-01' }
  })
  assertProblem(ledgerProblems(ledger({ tickets: [missingStep] }), new Map()), 'M2-0002', 'BLOCKED_EXTERNAL')
})

test('C21 a dependency cycle is reported once, and an unknown dependency id is a problem for any status', () => {
  const a = ticket({ id: 'M2-0001', status: 'IN_PROGRESS', depends_on: ['M2-0002'] })
  const b = ticket({ id: 'M2-0002', status: 'IN_PROGRESS', depends_on: ['M2-0001'] })
  const cycles = ledgerProblems(ledger({ tickets: [a, b] }), new Map()).filter((p) => p.includes('dependency cycle'))
  assert.equal(cycles.length, 1)

  const unknownDep = ticket({ id: 'M2-0003', status: 'IN_PROGRESS', depends_on: ['M2-9999'] })
  assertProblem(ledgerProblems(ledger({ tickets: [unknownDep] }), new Map()), 'M2-0003', 'M2-9999')

  // L1: depends_on ids must exist for every ticket, whatever its status — not only the statuses L3 checks for readiness.
  const todoWithUnknownDep = ticket({ id: 'M2-0004', status: 'TODO', depends_on: ['M2-9999'] })
  assertProblem(ledgerProblems(ledger({ tickets: [todoWithUnknownDep] }), new Map()), 'M2-0004', 'M2-9999')
})

test('C22 records keyed to a ticket absent from the ledger is a problem', () => {
  const recs = new Map([['M2-9999', [record({ ticket: 'M2-9999' })]]])
  assertProblem(ledgerProblems(ledger({ tickets: [] }), recs), 'M2-9999', 'unknown ticket')
})

test('C23 outputProblems: a missing file and a hash mismatch are each a problem; a matching file passes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-output-'))
  mkdirSync(join(dir, 'evidence', 'raw', 'M2-0001'), { recursive: true })
  const filePath = join(dir, 'evidence', 'raw', 'M2-0001', 'out.json')
  writeFileSync(filePath, '{"ok":true}')
  const goodHash = createHash('sha256').update(readFileSync(filePath)).digest('hex')

  const missing = new Map([['M2-0001', [record({ ticket: 'M2-0001', output: { path: 'evidence/raw/M2-0001/missing.json', sha256: goodHash } })]]])
  assertProblem(outputProblems(missing, dir), 'M2-0001', 'does not exist')

  const mismatch = new Map([['M2-0001', [record({ ticket: 'M2-0001', output: { path: 'evidence/raw/M2-0001/out.json', sha256: 'f'.repeat(64) } })]]])
  assertProblem(outputProblems(mismatch, dir), 'M2-0001', 'sha256')

  const ok = new Map([['M2-0001', [record({ ticket: 'M2-0001', output: { path: 'evidence/raw/M2-0001/out.json', sha256: goodHash } })]]])
  assert.deepEqual(outputProblems(ok, dir), [])
})

test('C24 CLI --ledger: a valid tree exits 0, a FAIL line exits 1 naming the ticket, bad args exit 2', () => {
  const root = mkdtempSync(join(tmpdir(), 'evidence-program-'))
  mkdirSync(join(root, 'ledger'), { recursive: true })
  mkdirSync(join(root, 'evidence', 'records'), { recursive: true })
  const ledgerPath = join(root, 'ledger', 'tickets.json')
  const recordsPath = join(root, 'evidence', 'records', 'M2-0001.jsonl')

  writeFileSync(ledgerPath, JSON.stringify({ tickets: [ticket({ id: 'M2-0001', status: 'DONE' })] }))
  writeFileSync(recordsPath, `${JSON.stringify(record({ ticket: 'M2-0001' }))}\n`)

  const cliPath = fileURLToPath(new URL('./check.mjs', import.meta.url))
  const ok = execFileSync(process.execPath, [cliPath, '--ledger', ledgerPath], { encoding: 'utf8' })
  assert.match(ok, /evidence: OK/)

  writeFileSync(
    recordsPath,
    `${JSON.stringify(record({ ticket: 'M2-0001' }))}\n${JSON.stringify(record({ ticket: 'M2-0001', result: 'FAIL', exit_code: 1, ci_run_id: 202 }))}\n`
  )
  assert.throws(
    () => execFileSync(process.execPath, [cliPath, '--ledger', ledgerPath], { encoding: 'utf8', stdio: 'pipe' }),
    { status: 1, stderr: /M2-0001/ }
  )

  for (const args of [[], ['--ledger', ledgerPath, '--pr-event', ledgerPath]]) {
    assert.throws(
      () => execFileSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', stdio: 'pipe' }),
      { status: 2 }
    )
  }
})

test('C25 ENGINEERING_COMPLETE requires a latest PASS record; a later FAIL withdraws an earlier PASS', () => {
  const t = ticket({
    id: 'M2-0001', status: 'ENGINEERING_COMPLETE', required_evidence: ['HOST_CONFIGURED'],
    external_blocker: { owner: 'o', unblock_step: 'u', needed_by: '2026-10-01', raised_on: '2026-09-01' }
  })
  const hostRecord = (result) => record({
    ticket: 'M2-0001', evidence_level: 'HOST_CONFIGURED', result, exit_code: result === 'PASS' ? 0 : 1,
    environment: { kind: 'qa-mac', host: 'qa-mac-1' }, output: { path: 'evidence/x.json', sha256: 'a'.repeat(64) }
  })

  const withdrawn = new Map([['M2-0001', [hostRecord('PASS'), hostRecord('FAIL')]]])
  assertProblem(ledgerProblems(ledger({ tickets: [t] }), withdrawn), 'M2-0001', 'at least one PASS record')

  const recovered = new Map([['M2-0001', [hostRecord('FAIL'), hostRecord('PASS')]]])
  assert.ok(noneMatching(ledgerProblems(ledger({ tickets: [t] }), recovered), 'at least one PASS record'))
})

test('C26 a non-boolean truthy closes_program does not exempt a capped DONE ticket from the cap', () => {
  const blocker = ticket({
    id: 'M2-0001', status: 'ENGINEERING_COMPLETE',
    external_blocker: { owner: 'o', unblock_step: 'u', needed_by: '2026-10-01', raised_on: '2026-09-01' }
  })
  const t = ticket({ id: 'M2-0002', status: 'DONE', depends_on: ['M2-0001'], closes_program: 'yes' })
  const recs = new Map([
    ['M2-0001', [record({ ticket: 'M2-0001' })]],
    ['M2-0002', [record({ ticket: 'M2-0002' })]]
  ])
  assertProblem(ledgerProblems(ledger({ tickets: [blocker, t] }), recs), 'M2-0002', 'only as ENGINEERING_COMPLETE')
})

test('C27 M2-0008 bundle check requires the content-free freeze repro matrix artifacts', () => {
  const root = mkdtempSync(join(tmpdir(), 'm2-0008-bundle-'))
  const writeJson = (name, value) => writeFileSync(join(root, name), `${JSON.stringify(value, null, 2)}\n`)
  writeFileSync(join(root, 'README.md'), '# M2-0008\n')
  writeFileSync(join(root, 'M2-0008.records.README.md'), '# Evidence Import Not Emitted\n')
  writeFileSync(join(root, 'M2-0008.lead-action.md'), 'LEAD_ACTION: File the two M2-0008 owner-bug evidence records and update the hypothesis ranking using OBSERVED and DERIVED labels.\n')
  writeJson('environment.json', { ticket: 'M2-0008', artifact_sha256: 'a'.repeat(64), dry_run: 1 })
  writeJson('node-options-fuse.json', { node_options_fuse: 'DISABLED_OR_UNAVAILABLE', detail: 'probe recorded' })
  writeJson('dataless-fixtures.json', { fixtures: [] })
  writeJson('external-blockers.json', { ticket: 'M2-0008', blockers: [{ status: 'BLOCKED_EXTERNAL', unblock_step: 'Run on QA account.' }] })
  writeJson('launch-plan.json', { electron_user_data_dir_switch: true })
  writeJson('diagnostic-reports.json', {
    consented: false,
    source: 'Library/Logs/DiagnosticReports',
    filter: 'Metis/AskToto process names or sampled process ids only',
    copied: []
  })
  writeJson('fifo-fixtures.json', {
    kind: 'fifo',
    count: 6,
    fixtures: [
      { path: 'one.md', opened_by_1_9_6: false },
      { path: 'two.md', opened_by_1_9_6: false },
      { path: 'three.md', opened_by_1_9_6: false },
      { path: 'four.md', opened_by_1_9_6: false },
      { path: '.brain/index.json', opened_by_1_9_6: false },
      { path: '.brain/entities/person/person.json', opened_by_1_9_6: false }
    ]
  })
  writeFileSync(join(root, 'matrix.jsonl'), [
    { row: 'row-1-history-open' },
    { row: 'row-2-brain-status-blocked-brain' },
    { row: 'row-3-macos-activate' },
    { row: 'row-4-second-instance-reopen' },
    { row: 'row-5-dataless-brain-idle', fixture: 'dataless-brain-index' },
    { row: 'row-9-network-off-flapping', fixture: 'dataless-meeting' }
  ].map((row) => JSON.stringify(row)).join('\n') + '\n')
  writeFileSync(join(root, 'interrupt-results.jsonl'), [
    'network-off',
    'file-provider-cancel',
    'process-signal'
  ].map((interrupt) => JSON.stringify({ interrupt })).join('\n') + '\n')

  assert.deepEqual(m2_0008BundleProblems(root), [])

  writeJson('fifo-fixtures.json', { kind: 'fifo', count: 1, fixtures: [{ path: 'one.md' }] })
  const problems = m2_0008BundleProblems(root)
  assertProblem(problems, 'at least six FIFO fixtures')
  assertProblem(problems, 'blocked .brain/index.json')
  assertProblem(problems, 'opened_by_1_9_6')

  writeJson('fifo-fixtures.json', {
    kind: 'fifo',
    count: 6,
    fixtures: [
      { path: 'one.md', opened_by_1_9_6: false },
      { path: 'two.md', opened_by_1_9_6: false },
      { path: 'three.md', opened_by_1_9_6: false },
      { path: 'four.md', opened_by_1_9_6: false },
      { path: '.brain/index.json', opened_by_1_9_6: false },
      { path: '.brain/entities/person/person.json', opened_by_1_9_6: false }
    ]
  })
  writeJson('diagnostic-reports.json', { consented: true, filter: 'all newer reports', copied: [] })
  assertProblem(m2_0008BundleProblems(root), 'DiagnosticReports', 'restricted')

  writeJson('diagnostic-reports.json', {
    consented: true,
    source: 'Library/Logs/DiagnosticReports',
    filter: 'Metis/AskToto process names or sampled process ids only',
    copied: []
  })
  writeFileSync(join(root, 'matrix.jsonl'), [
    { row: 'row-1-history-open' },
    { row: 'row-2-brain-status-blocked-brain' },
    { row: 'row-3-macos-activate' },
    { row: 'row-4-second-instance-reopen' },
    { row: 'row-5-dataless-brain-idle', fixture: 'qa-cloud/.brain/index.json' },
    { row: 'row-9-network-off-flapping', fixture: 'qa-cloud/meeting.md' }
  ].map((row) => JSON.stringify(row)).join('\n') + '\n')
  assertProblem(m2_0008BundleProblems(root), 'row-5-dataless-brain-idle', 'content-free fixture label')
  assertProblem(m2_0008BundleProblems(root), 'row-9-network-off-flapping', 'content-free fixture label')

  writeFileSync(join(root, 'matrix.jsonl'), [
    { row: 'row-1-history-open' },
    { row: 'row-2-brain-status-blocked-brain' },
    { row: 'row-3-macos-activate' },
    { row: 'row-4-second-instance-reopen' },
    { row: 'row-5-dataless-brain-idle', fixture: 'dataless-brain-index' },
    { row: 'row-9-network-off-flapping', fixture: 'dataless-meeting' }
  ].map((row) => JSON.stringify(row)).join('\n') + '\n')
  writeFileSync(join(root, 'M2-0008.lead-action.md'), 'LEAD_ACTION: File the evidence records only.\n')
  assertProblem(m2_0008BundleProblems(root), 'hypothesis ranking')
  assertProblem(m2_0008BundleProblems(root), 'OBSERVED/DERIVED')
})

test('C28 CLI --ticket M2-0008 validates a freeze repro bundle path', () => {
  const root = mkdtempSync(join(tmpdir(), 'm2-0008-bundle-cli-'))
  const writeJson = (name, value) => writeFileSync(join(root, name), `${JSON.stringify(value)}\n`)
  writeFileSync(join(root, 'README.md'), '# M2-0008\n')
  writeFileSync(join(root, 'M2-0008.records.README.md'), '# Evidence Import Not Emitted\n')
  writeFileSync(join(root, 'M2-0008.lead-action.md'), 'LEAD_ACTION: File the two M2-0008 owner-bug evidence records and update the hypothesis ranking using OBSERVED and DERIVED labels.\n')
  writeJson('environment.json', { ticket: 'M2-0008', artifact_sha256: 'a'.repeat(64) })
  writeJson('node-options-fuse.json', { node_options_fuse: 'NOT_EXERCISED', detail: 'dry-run' })
  writeJson('dataless-fixtures.json', { fixtures: [] })
  writeJson('external-blockers.json', { ticket: 'M2-0008', blockers: [{ status: 'BLOCKED_EXTERNAL', unblock_step: 'Run on QA account.' }] })
  writeJson('launch-plan.json', { electron_user_data_dir_switch: true })
  writeJson('diagnostic-reports.json', {
    consented: false,
    source: 'Library/Logs/DiagnosticReports',
    filter: 'Metis/AskToto process names or sampled process ids only',
    copied: []
  })
  writeJson('fifo-fixtures.json', {
    kind: 'fifo',
    count: 6,
    fixtures: [
      { path: 'one.md', opened_by_1_9_6: null },
      { path: 'two.md', opened_by_1_9_6: null },
      { path: 'three.md', opened_by_1_9_6: null },
      { path: 'four.md', opened_by_1_9_6: null },
      { path: '.brain/index.json', opened_by_1_9_6: null },
      { path: '.brain/entities/account/account.json', opened_by_1_9_6: null }
    ]
  })
  writeFileSync(join(root, 'matrix.jsonl'), [
    { row: 'row-1-history-open' },
    { row: 'row-2-brain-status-blocked-brain' },
    { row: 'row-3-macos-activate' },
    { row: 'row-4-second-instance-reopen' },
    { row: 'row-5-dataless-brain-idle', fixture: 'dataless-brain-index' },
    { row: 'row-9-network-off-flapping', fixture: 'dataless-meeting' }
  ].map((row) => JSON.stringify(row)).join('\n') + '\n')
  writeFileSync(join(root, 'interrupt-results.jsonl'), [
    'network-off',
    'file-provider-cancel',
    'process-signal'
  ].map((interrupt) => JSON.stringify({ interrupt })).join('\n') + '\n')

  const cliPath = fileURLToPath(new URL('./check.mjs', import.meta.url))
  const output = execFileSync(process.execPath, [cliPath, '--ticket', 'M2-0008', '--bundle', root], { encoding: 'utf8' })
  assert.match(output, /M2-0008 bundle: OK/)
})

const STALL_BUNDLE = '0f8fad5b-d9cb-469f-a165-70867728950e.1700000000000.31000.txt'

function writeM2_0194Bundle(root, { environment = {}, leadAction } = {}) {
  const writeJson = (name, value) => writeFileSync(join(root, name), `${JSON.stringify(value)}\n`)
  const writeRows = (name, rows) => writeFileSync(join(root, name), rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  writeFileSync(join(root, 'README.md'), '# M2-0194\n')
  writeFileSync(join(root, 'M2-0194.lead-action.md'), leadAction ?? 'LEAD_ACTION: File the M2-0194 LIVE_VERIFIED record from this bundle.\n')
  writeJson('environment.json', { ticket: 'M2-0194', artifact_sha256: 'a'.repeat(64), candidate_run: '123456', ...environment })
  writeJson('external-blockers.json', { ticket: 'M2-0194', blockers: [{ status: 'BLOCKED_EXTERNAL', unblock_step: 'Run on QA account.' }] })
  writeJson('stall-bundle-names.json', { names: [STALL_BUNDLE] })
  writeRows('matrix.jsonl', [
    { row: 'row-1-history-open' },
    { row: 'row-2-brain-status-blocked-brain' },
    { row: 'row-3-macos-activate' },
    { row: 'row-4-second-instance-reopen' },
    { row: 'row-5-dataless-brain-idle', fixture: 'dataless-brain-index' },
    { row: 'row-9-network-off-flapping', fixture: 'dataless-meeting' }
  ])
  writeRows('interrupt-results.jsonl', ['network-off', 'file-provider-cancel', 'process-signal'].map((interrupt) => ({ interrupt })))
  writeRows('stall-excerpt.jsonl', [{ event: 'app.stall.summary', count: 1 }])
  writeRows('sampler-excerpt.jsonl', [{ event: 'app.stall.sampled', stalledMs: 31000, bundle: STALL_BUNDLE }])
  writeRows('reveal-excerpt.jsonl', [{ event: 'reveal', outcome: 'shown' }])
  writeRows('sidecar-excerpt.jsonl', [{ event: 'sidecar.spawn', name: 'asr' }])
}

test('C33 M2-0194 bundle check requires the matrix, the four excerpts and stall bundle names only', () => {
  const root = mkdtempSync(join(tmpdir(), 'm2-0194-bundle-'))
  writeM2_0194Bundle(root)
  assert.deepEqual(m2_0194BundleProblems(root), [])

  writeFileSync(join(root, 'reveal-excerpt.jsonl'), `${JSON.stringify({ event: 'sidecar.spawn' })}\n`)
  assertProblem(m2_0194BundleProblems(root), 'reveal-excerpt.jsonl', 'reveal excerpt')

  writeM2_0194Bundle(root)
  writeFileSync(join(root, 'stall-bundle-names.json'), `${JSON.stringify({ names: [`${STALL_BUNDLE}`, 'Thread 1 (main)'] })}\n`)
  assertProblem(m2_0194BundleProblems(root), 'stall bundle file names only')

  writeM2_0194Bundle(root)
  writeFileSync(join(root, 'environment.json'), `${JSON.stringify({ ticket: 'M2-0008', artifact_sha256: 'A', candidate_run: 'x' })}\n`)
  const problems = m2_0194BundleProblems(root)
  assertProblem(problems, 'ticket must be M2-0194')
  assertProblem(problems, 'lowercase sha256')
  assertProblem(problems, 'candidate_run')

  writeM2_0194Bundle(root)
  writeFileSync(join(root, 'matrix.jsonl'), `${JSON.stringify({ row: 'row-1-history-open' })}\n`)
  assertProblem(m2_0194BundleProblems(root), 'missing row-9-network-off-flapping')

  writeM2_0194Bundle(root)
  writeFileSync(join(root, 'M2-0194.lead-action.md'), 'File it.\n')
  const leadProblems = m2_0194BundleProblems(root)
  assertProblem(leadProblems, 'missing LEAD_ACTION handoff')
  assertProblem(leadProblems, 'LIVE_VERIFIED')

  writeM2_0194Bundle(root, { environment: { dry_run: 1, mode: 'dry-run' } })
  assertProblem(m2_0194BundleProblems(root), 'dry-run bundles', 'LIVE_VERIFIED')

  writeM2_0194Bundle(root, {
    environment: { dry_run: 1, mode: 'dry-run' },
    leadAction: 'LEAD_ACTION: File M2-0194 LOCALLY_TESTED support only; do not file live evidence from this dry run.\n'
  })
  assert.deepEqual(m2_0194BundleProblems(root), [])

  rmSync(join(root, 'sampler-excerpt.jsonl'))
  assertProblem(m2_0194BundleProblems(root), 'sampler-excerpt.jsonl: missing from M2-0194 bundle')
})

test('C34 CLI --ticket M2-0194 validates a bundle and rejects an incomplete one; other tickets exit 2', () => {
  const root = mkdtempSync(join(tmpdir(), 'm2-0194-bundle-cli-'))
  writeM2_0194Bundle(root)
  const cliPath = fileURLToPath(new URL('./check.mjs', import.meta.url))
  const output = execFileSync(process.execPath, [cliPath, '--ticket', 'M2-0194', '--bundle', root], { encoding: 'utf8' })
  assert.match(output, /M2-0194 bundle: OK/)

  rmSync(join(root, 'stall-bundle-names.json'))
  assert.throws(() => execFileSync(process.execPath, [cliPath, '--ticket', 'M2-0194', '--bundle', root], { stdio: 'pipe' }), (error) => error.status === 1)
  assert.throws(() => execFileSync(process.execPath, [cliPath, '--ticket', 'M2-0001', '--bundle', root], { stdio: 'pipe' }), (error) => error.status === 2)
})

const HOSTED_AUTOMATIC_ROWS = ['row-1-history-open', 'row-2-brain-status-blocked-brain', 'row-3-macos-activate', 'row-4-second-instance-reopen']
const HOSTED_UNBLOCK = 'Provision a test cloud-file account (there is none after D-9) and rerun in QA-live mode.'

/** A well-formed `run-matrix.sh --hosted-live` bundle (M2-0462); each test breaks one part of it. */
function hostedLiveBundle({ symptomRow = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'm2-0462-hosted-bundle-'))
  const writeJson = (name, value) => writeFileSync(join(root, name), `${JSON.stringify(value, null, 2)}\n`)
  const writeJsonl = (name, rows) => writeFileSync(join(root, name), rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  mkdirSync(join(root, 'samples'))
  writeFileSync(join(root, 'README.md'), '# M2-0008 (hosted-live)\n')
  writeFileSync(join(root, 'M2-0008.records.README.md'), '# Evidence Import Manifest\n')
  writeFileSync(join(root, 'M2-0008.lead-action.md'), 'LEAD_ACTION: File the two M2-0008 owner-bug evidence records and update the hypothesis ranking using OBSERVED and DERIVED labels.\n')
  writeJson('environment.json', {
    ticket: 'M2-0008',
    artifact_sha256: 'a'.repeat(64),
    dry_run: 0,
    host: { label: 'macos-latest', os: 'Darwin', os_version: '15.5', arch: 'arm64', memory_bytes: 7516192768 },
    mode: 'hosted-live'
  })
  writeJson('node-options-fuse.json', { node_options_fuse: 'DISABLED_OR_UNAVAILABLE', detail: 'probe recorded' })
  writeJson('dataless-fixtures.json', { fixtures: [] })
  writeJson('external-blockers.json', {
    ticket: 'M2-0008',
    mode: 'hosted-live',
    blockers: [{
      status: 'BLOCKED_EXTERNAL',
      rows: ['row-5-dataless-brain-idle', 'row-9-network-off-flapping'],
      interrupts: ['network-off', 'file-provider-cancel'],
      unblock_step: HOSTED_UNBLOCK
    }]
  })
  writeJson('launch-plan.json', { electron_user_data_dir_switch: true })
  writeJson('diagnostic-reports.json', {
    consented: false,
    source: 'Library/Logs/DiagnosticReports',
    filter: 'Metis/AskToto process names or sampled process ids only',
    copied: []
  })
  writeJson('fifo-fixtures.json', {
    kind: 'fifo',
    count: 7,
    opened_by_1_9_6: 2,
    fixtures: [
      { path: 'Métis Meetings/one.md', opened_by_1_9_6: true },
      { path: 'Métis Meetings/two.md', opened_by_1_9_6: false },
      { path: 'Métis Meetings/three.md', opened_by_1_9_6: false },
      { path: 'Métis Meetings/four.md', opened_by_1_9_6: false },
      { path: 'Métis Meetings/.brain/index.json', opened_by_1_9_6: true },
      { path: 'Métis Meetings/.brain/entities/person/person.json', opened_by_1_9_6: false },
      { path: 'Métis Meetings/.brain/entities/account/account.json', opened_by_1_9_6: false }
    ]
  })
  const matrix = []
  for (const row of HOSTED_AUTOMATIC_ROWS) {
    const symptom = row === symptomRow
    const operatorResult = symptom ? 'observed' : 'pass'
    writeFileSync(join(root, 'samples', `${row}-main.sample.txt`), 'Sampling process 100\n')
    writeFileSync(join(root, 'samples', `${row}-renderer-104.sample.txt`), 'Sampling process 104\n')
    matrix.push({ row, sampled: true, main_pid: 100, main_sample: true, renderer_attempts: 1, renderer_samples: 1, renderers_selected_by: '--type=renderer' })
    matrix.push({
      row,
      operator_result: operatorResult,
      automatic: true,
      drive_method: 'cdp Runtime.evaluate',
      precondition: 'ok',
      observation: {
        operator_result: operatorResult,
        symptom_observed: symptom,
        reason: symptom ? 'round-trip-timeout' : 'all-round-trips-answered',
        cdp: {
          reachable: true,
          page_targets: 1,
          renderer_round_trip: 'answered',
          renderer_round_trip_ms: 12,
          main_round_trip: symptom ? 'timeout' : 'answered',
          main_answered: !symptom,
          drive: 'none',
          window_visible: true,
          window_visible_observed_by: 'cdp:document.visibilityState'
        }
      }
    })
  }
  matrix.push({ row: 'row-5-dataless-brain-idle', operator_result: 'BLOCKED_EXTERNAL', status: 'BLOCKED_EXTERNAL', unblock_step: HOSTED_UNBLOCK, automatic: false, fixture: 'dataless-brain-index' })
  matrix.push({ row: 'row-9-network-off-flapping', operator_result: 'BLOCKED_EXTERNAL', status: 'BLOCKED_EXTERNAL', unblock_step: HOSTED_UNBLOCK, automatic: false, fixture: 'dataless-meeting' })
  writeJsonl('matrix.jsonl', matrix)
  writeJsonl('interrupt-results.jsonl', [
    { interrupt: 'network-off', result: 'BLOCKED_EXTERNAL', status: 'BLOCKED_EXTERNAL', unblock_step: HOSTED_UNBLOCK },
    { interrupt: 'file-provider-cancel', result: 'BLOCKED_EXTERNAL', status: 'BLOCKED_EXTERNAL', unblock_step: HOSTED_UNBLOCK },
    { interrupt: 'process-signal', result: 'pass', automatic: true, signal: 'TERM', exited_within_10s: true, waited_seconds: 1 }
  ])
  writeJson('hosted-live-summary.json', {
    ticket: 'M2-0008',
    mode: 'hosted-live',
    symptom_rows: symptomRow ? [symptomRow] : [],
    reproduced: symptomRow !== null,
    conclusion: symptomRow ? 'reproduced: ...' : 'documented-unsuccessful: ...'
  })
  writeJson('owner-bug-records.json', { ticket: 'M2-0008', owner_bug_records: [] })
  writeJson('M2-0008.evidence-import.json', {
    ticket: 'M2-0008',
    mode: 'hosted-live',
    result: 'PASS',
    artifact_sha256: 'a'.repeat(64),
    build_run_id: 123,
    ci_run_id: 456,
    environment: { kind: 'hosted-runner', host: 'macos-latest' }
  })
  return { root, writeJson, writeJsonl, matrix }
}

test('C29 M2-0008 hosted-live bundle: a documented-unsuccessful run and a reproduced run are both valid', () => {
  assert.deepEqual(m2_0008BundleProblems(hostedLiveBundle().root), [])
  assert.deepEqual(m2_0008BundleProblems(hostedLiveBundle({ symptomRow: 'row-1-history-open' }).root), [])

  const cliPath = fileURLToPath(new URL('./check.mjs', import.meta.url))
  const output = execFileSync(process.execPath, [cliPath, '--ticket', 'M2-0008', '--bundle', hostedLiveBundle().root], { encoding: 'utf8' })
  assert.match(output, /M2-0008 bundle: OK/)
})

test('C30 M2-0008 hosted-live bundle requires mode artifacts, host facts and exercised, sampled automatic rows', () => {
  const noSummaryFile = hostedLiveBundle()
  rmSync(join(noSummaryFile.root, 'hosted-live-summary.json'))
  assertProblem(m2_0008BundleProblems(noSummaryFile.root), 'hosted-live-summary.json', 'missing from the hosted-live bundle')

  const missing = hostedLiveBundle()
  missing.writeJson('environment.json', { ticket: 'M2-0008', artifact_sha256: 'a'.repeat(64), mode: 'hosted-live', host: { label: 'macos-latest' } })
  assertProblem(m2_0008BundleProblems(missing.root), 'environment.json', 'os_version, arch and memory_bytes')

  const notExercised = hostedLiveBundle()
  notExercised.writeJsonl('matrix.jsonl', notExercised.matrix.map((entry) =>
    entry.row === 'row-3-macos-activate' && 'operator_result' in entry ? { ...entry, operator_result: 'not-exercised' } : entry))
  assertProblem(m2_0008BundleProblems(notExercised.root), 'row-3-macos-activate', 'automatic row that was exercised')

  const typed = hostedLiveBundle()
  typed.writeJsonl('matrix.jsonl', typed.matrix.map((entry) =>
    entry.row === 'row-1-history-open' && 'operator_result' in entry ? { ...entry, operator_result: 'observed' } : entry))
  assertProblem(m2_0008BundleProblems(typed.root), 'row-1-history-open', 'derived from its observation')

  const noObservation = hostedLiveBundle()
  noObservation.writeJsonl('matrix.jsonl', noObservation.matrix.map((entry) =>
    entry.row === 'row-2-brain-status-blocked-brain' && 'operator_result' in entry ? { ...entry, observation: null, drive_method: '' } : entry))
  assertProblem(m2_0008BundleProblems(noObservation.root), 'row-2-brain-status-blocked-brain', 'renderer round trip, main answer and window observation')
  assertProblem(m2_0008BundleProblems(noObservation.root), 'row-2-brain-status-blocked-brain', 'drive_method')

  const firstThree = hostedLiveBundle()
  firstThree.writeJsonl('matrix.jsonl', firstThree.matrix.map((entry) =>
    entry.row === 'row-4-second-instance-reopen' && 'sampled' in entry ? { ...entry, renderers_selected_by: undefined } : entry))
  assertProblem(m2_0008BundleProblems(firstThree.root), 'row-4-second-instance-reopen', 'role-selected renderer samples')

  const unsampled = hostedLiveBundle()
  unsampled.writeJsonl('matrix.jsonl', unsampled.matrix.map((entry) =>
    entry.row === 'row-1-history-open' && 'sampled' in entry ? { ...entry, sampled: false, main_sample: false } : entry))
  assertProblem(m2_0008BundleProblems(unsampled.root), 'row-1-history-open', 'main and role-selected renderer samples')

  const fifoUnknown = hostedLiveBundle()
  fifoUnknown.writeJson('fifo-fixtures.json', {
    kind: 'fifo',
    count: 6,
    fixtures: ['a.md', 'b.md', 'c.md', 'd.md', '.brain/index.json', 'e.json'].map((path) => ({ path, opened_by_1_9_6: null }))
  })
  assertProblem(m2_0008BundleProblems(fifoUnknown.root), 'fifo-fixtures.json', 'true or false')

  const unprobed = hostedLiveBundle()
  unprobed.writeJson('node-options-fuse.json', { node_options_fuse: 'NOT_EXERCISED', detail: 'dry-run' })
  assertProblem(m2_0008BundleProblems(unprobed.root), 'node-options-fuse.json', 'hosted-live')
})

test('C31 M2-0008 hosted-live bundle requires blocked rows with unblock steps, the process-signal run and a hosted-runner import', () => {
  const unblocked = hostedLiveBundle()
  unblocked.writeJsonl('matrix.jsonl', unblocked.matrix.map((entry) =>
    entry.row === 'row-9-network-off-flapping' ? { ...entry, unblock_step: '' } : entry))
  assertProblem(m2_0008BundleProblems(unblocked.root), 'row-9-network-off-flapping', 'BLOCKED_EXTERNAL with an unblock_step')

  const unlisted = hostedLiveBundle()
  unlisted.writeJson('external-blockers.json', { ticket: 'M2-0008', blockers: [{ status: 'BLOCKED_EXTERNAL', rows: [], unblock_step: HOSTED_UNBLOCK }] })
  assertProblem(m2_0008BundleProblems(unlisted.root), 'row-5-dataless-brain-idle', 'listed in external-blockers.json')
  assertProblem(m2_0008BundleProblems(unlisted.root), 'file-provider-cancel', 'listed in external-blockers.json')

  const noSignal = hostedLiveBundle()
  noSignal.writeJsonl('interrupt-results.jsonl', [
    { interrupt: 'network-off', result: 'BLOCKED_EXTERNAL', status: 'BLOCKED_EXTERNAL', unblock_step: HOSTED_UNBLOCK },
    { interrupt: 'file-provider-cancel', result: 'BLOCKED_EXTERNAL', status: 'BLOCKED_EXTERNAL', unblock_step: HOSTED_UNBLOCK },
    { interrupt: 'process-signal', result: 'not-recorded' }
  ])
  assertProblem(m2_0008BundleProblems(noSignal.root), 'process-signal', 'exited_within_10s')

  const qaHost = hostedLiveBundle()
  qaHost.writeJson('M2-0008.evidence-import.json', {
    ticket: 'M2-0008',
    mode: 'hosted-live',
    artifact_sha256: 'b'.repeat(64),
    build_run_id: 123,
    qa_host_label: 'qa-mac-1',
    environment: { kind: 'qa-mac', host: 'qa-mac-1' }
  })
  const importProblems = m2_0008BundleProblems(qaHost.root)
  assertProblem(importProblems, 'evidence-import.json', 'hosted-runner kind')
  assertProblem(importProblems, 'evidence-import.json', 'QA host label')
  assertProblem(importProblems, 'evidence-import.json', 'artifact_sha256 must match')

  const mismatch = hostedLiveBundle({ symptomRow: 'row-2-brain-status-blocked-brain' })
  mismatch.writeJson('hosted-live-summary.json', { ticket: 'M2-0008', mode: 'hosted-live', reproduced: false, conclusion: 'documented-unsuccessful: ...' })
  assertProblem(m2_0008BundleProblems(mismatch.root), 'hosted-live-summary.json', 'reproduced must match')

  const noSummary = hostedLiveBundle()
  noSummary.writeJson('hosted-live-summary.json', { ticket: 'M2-0008' })
  assertProblem(m2_0008BundleProblems(noSummary.root), 'hosted-live-summary.json', 'mode, reproduced and conclusion')
})

// --- PR rules (P1-P7) and githubApi (G1) ---

const greenRun = Object.freeze({ path: TEST_WORKFLOW, head_sha: SHA1_A, status: 'completed', conclusion: 'success' })
const redRun = Object.freeze({ path: TEST_WORKFLOW, head_sha: SHA1_B, status: 'completed', conclusion: 'failure' })

function fakeGithub({ runs = {}, ancestors = () => true, throwOnRun = false } = {}) {
  return {
    async run(id) {
      if (throwOnRun) throw new Error('HTTP 500')
      return runs[id] ?? null
    },
    async isAncestor(a, b) {
      return ancestors(a, b)
    }
  }
}

const evidenceBody = (rec) => `## Evidence record\n\n\`\`\`json evidence\n${JSON.stringify(rec)}\n\`\`\`\n`

test('P1 prProblems with no evidence block is empty', async () => {
  const problems = await prProblems({ body: 'no block here', headSha: SHA1_A, prNumber: 42, github: fakeGithub(), fileExists: () => true })
  assert.deepEqual(problems, [])
})

test('P2 a valid LOCALLY_TESTED block with a green run on the head SHA passes', async () => {
  const rec = record({ commit: SHA1_A })
  const problems = await prProblems({
    body: evidenceBody(rec), headSha: SHA1_A, prNumber: 42,
    github: fakeGithub({ runs: { 101: greenRun } }), fileExists: () => true
  })
  assert.deepEqual(problems, [])
})

const liveRecord = (environment, overrides = {}) => {
  const { pr, ...withoutPr } = record({
    evidence_level: 'LIVE_VERIFIED',
    ci_run_id: 303,
    artifact_sha256: 'a'.repeat(64),
    build_run_id: 303,
    environment,
    command: 'npm run check:packaged-launch',
    output: { path: 'evidence/raw/M2-0001/launch.json', sha256: 'a'.repeat(64) },
    ...overrides
  })
  return withoutPr
}

// Writes the records as the program's JSONL store and loads them the way the CLI does.
function programWithRecords(records, ticketOverrides) {
  const root = mkdtempSync(join(tmpdir(), 'evidence-hosted-'))
  mkdirSync(join(root, 'ledger'), { recursive: true })
  mkdirSync(join(root, 'evidence', 'records'), { recursive: true })
  const ledgerPath = join(root, 'ledger', 'tickets.json')
  writeFileSync(ledgerPath, JSON.stringify({ tickets: [ticket(ticketOverrides)] }))
  writeFileSync(join(root, 'evidence', 'records', 'M2-0001.jsonl'), records.map((r) => `${JSON.stringify(r)}\n`).join(''))
  return loadProgram(ledgerPath)
}

test('H1 a LIVE_VERIFIED requirement closes on a hosted-runner record and not on a ci record', () => {
  const requirement = { id: 'M2-0001', status: 'DONE', required_evidence: ['LIVE_VERIFIED'] }

  const hosted = programWithRecords([liveRecord({ kind: 'hosted-runner', host: 'macos-latest' })], requirement)
  assert.deepEqual(hosted.problems, [])
  assert.equal(hosted.recordsByTicket.get('M2-0001')?.length, 1)
  assert.deepEqual(ledgerProblems(hosted.ledger, hosted.recordsByTicket), [])

  // The record store drops a ci LIVE_VERIFIED record, so the ticket has no evidence and stays open.
  const ci = programWithRecords([liveRecord({ kind: 'ci', host: 'ubuntu-latest' })], requirement)
  assertProblem(ci.problems, "must not be 'ci'", 'LIVE_VERIFIED')
  assert.equal(ci.recordsByTicket.has('M2-0001'), false)
  assertProblem(ledgerProblems(ci.ledger, ci.recordsByTicket), 'M2-0001', 'LIVE_VERIFIED')
})

test('H2 --pr-event accepts a hosted-runner LIVE_VERIFIED block without resolving ci_run_id as a Build & Test run', async () => {
  const rec = liveRecord({ kind: 'hosted-runner', host: 'windows-latest' })
  const problems = await prProblems({
    body: evidenceBody(rec), headSha: SHA1_A, prNumber: 42,
    github: fakeGithub({ throwOnRun: true }), fileExists: () => true
  })
  assert.deepEqual(problems, [])
})

test('P3 a stale commit or a mismatched PR number is a problem', async () => {
  const github = fakeGithub({ runs: { 101: greenRun } })
  const staleCommit = await prProblems({ body: evidenceBody(record({ commit: SHA1_A })), headSha: SHA1_B, prNumber: 42, github, fileExists: () => true })
  assertProblem(staleCommit, 'commit')

  const wrongPr = await prProblems({ body: evidenceBody(record({ commit: SHA1_A, pr: 7 })), headSha: SHA1_A, prNumber: 42, github, fileExists: () => true })
  assertProblem(wrongPr, 'pr')
})

test('P4 a run on another workflow, another SHA, in progress, failed, or missing is each a problem, named ci_run_id', async () => {
  const variants = {
    otherWorkflow: { ...greenRun, path: '.github/workflows/other.yml' },
    otherSha: { ...greenRun, head_sha: SHA1_B },
    inProgress: { ...greenRun, status: 'in_progress', conclusion: null },
    failed: { ...greenRun, conclusion: 'failure' }
  }
  for (const run of Object.values(variants)) {
    const problems = await prProblems({
      body: evidenceBody(record({ commit: SHA1_A })), headSha: SHA1_A, prNumber: 42,
      github: fakeGithub({ runs: { 101: run } }), fileExists: () => true
    })
    assertProblem(problems, 'ci_run_id:')
  }
  const missing = await prProblems({
    body: evidenceBody(record({ commit: SHA1_A })), headSha: SHA1_A, prNumber: 42,
    github: fakeGithub({ runs: {} }), fileExists: () => true
  })
  assertProblem(missing, 'ci_run_id: not found')
})

test('P5 repro requires a failed, ancestor run and an existing test file; its run problems are named repro.ci_run_id', async () => {
  const rec = record({ commit: SHA1_A, repro: { test: 'scripts/evidence/check.test.mjs', commit: SHA1_B, ci_run_id: 202 } })

  const redRunSucceeded = await prProblems({
    body: evidenceBody(rec), headSha: SHA1_A, prNumber: 42,
    github: fakeGithub({ runs: { 101: greenRun, 202: { ...redRun, conclusion: 'success' } } }), fileExists: () => true
  })
  assertProblem(redRunSucceeded, 'repro.ci_run_id:')

  const notAnAncestor = await prProblems({
    body: evidenceBody(rec), headSha: SHA1_A, prNumber: 42,
    github: fakeGithub({ runs: { 101: greenRun, 202: redRun }, ancestors: () => false }), fileExists: () => true
  })
  assertProblem(notAnAncestor, 'ancestor')

  const missingTest = await prProblems({
    body: evidenceBody(rec), headSha: SHA1_A, prNumber: 42,
    github: fakeGithub({ runs: { 101: greenRun, 202: redRun } }), fileExists: () => false
  })
  assertProblem(missingTest, 'repro.test')

  const valid = await prProblems({
    body: evidenceBody(rec), headSha: SHA1_A, prNumber: 42,
    github: fakeGithub({ runs: { 101: greenRun, 202: redRun } }), fileExists: () => true
  })
  assert.deepEqual(valid, [])
})

test('P5b wired paths missing from the checkout are each a problem, named wired.client and wired.contract_fake; existing paths pass', async () => {
  const rec = record({
    commit: SHA1_A,
    wired: {
      client: 'src/main/foo.ts',
      contract_fake: 'src/main/foo.contract-fake.test.ts',
      probe: 'node scripts/probe.mjs',
      capability: 'foo',
      unblock_step: 'ship it'
    }
  })

  const missing = await prProblems({
    body: evidenceBody(rec), headSha: SHA1_A, prNumber: 42,
    github: fakeGithub({ runs: { 101: greenRun } }), fileExists: () => false
  })
  assertProblem(missing, 'wired.client')
  assertProblem(missing, 'wired.contract_fake')

  const present = await prProblems({
    body: evidenceBody(rec), headSha: SHA1_A, prNumber: 42,
    github: fakeGithub({ runs: { 101: greenRun } }), fileExists: () => true
  })
  assert.deepEqual(present, [])
})

test('P6 the CLI prints a distinct message when a PR body carries no evidence block', () => {
  const cliPath = fileURLToPath(new URL('./check.mjs', import.meta.url))
  const eventDir = mkdtempSync(join(tmpdir(), 'evidence-event-'))
  const eventPath = join(eventDir, 'event.json')
  writeFileSync(eventPath, JSON.stringify({
    pull_request: { body: 'nothing to see here', head: { sha: SHA1_A }, number: 42 },
    repository: { full_name: 'mysticalsin/AskToto-Mantu' }
  }))
  const output = execFileSync(process.execPath, [cliPath, '--pr-event', eventPath], { encoding: 'utf8' })
  assert.match(output, /no evidence record/)
})

test('P7 a GitHub API failure becomes a problem, not a crash', async () => {
  const problems = await prProblems({
    body: evidenceBody(record({ commit: SHA1_A })), headSha: SHA1_A, prNumber: 42,
    github: fakeGithub({ throwOnRun: true }), fileExists: () => true
  })
  assertProblem(problems, 'ci_run_id', 'could not verify')
})

test('P8 every problem is prefixed with its block index and evidence_level; a non-string evidence_level prefixes as unknown level', async () => {
  const valid = record({ commit: SHA1_A })
  const stale = record({ commit: SHA1_B })
  const twoBlockBody = `${evidenceBody(valid)}\n${evidenceBody(stale)}`
  const problems = await prProblems({
    body: twoBlockBody, headSha: SHA1_A, prNumber: 42,
    github: fakeGithub({ runs: { 101: greenRun } }), fileExists: () => true
  })
  assert.ok(problems.length > 0)
  assert.ok(problems.every((p) => p.startsWith('evidence[1] LOCALLY_TESTED: ')))
  assert.ok(!problems.some((p) => p.startsWith('evidence[0]')))

  const unknownLevelProblems = await prProblems({
    body: evidenceBody(record({ evidence_level: 123, commit: SHA1_A })), headSha: SHA1_A, prNumber: 42,
    github: fakeGithub({ runs: { 101: greenRun } }), fileExists: () => true
  })
  assert.ok(unknownLevelProblems.length > 0)
  assert.ok(unknownLevelProblems.every((p) => p.startsWith('evidence[0] unknown level: ')))
})

test('G1 githubApi builds the expected URLs, the bearer header, and maps run/compare status', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, headers: options.headers })
    if (url.includes('/actions/runs/404')) return { status: 404, ok: false }
    if (url.includes('/actions/runs/')) {
      return { status: 200, ok: true, json: async () => ({ path: TEST_WORKFLOW, head_sha: SHA1_A, status: 'completed', conclusion: 'success' }) }
    }
    if (url.includes('/compare/')) {
      const ahead = url.includes(`/compare/${SHA1_B}...${SHA1_A}`)
      return { status: 200, ok: true, json: async () => ({ status: ahead ? 'ahead' : 'diverged' }) }
    }
    throw new Error(`unexpected url ${url}`)
  }

  const withToken = githubApi('mysticalsin/AskToto-Mantu', 'secret-token', fetchImpl)
  const run = await withToken.run(101)
  assert.equal(run.head_sha, SHA1_A)
  assert.ok(calls[0].url.includes('mysticalsin/AskToto-Mantu'))
  assert.ok(calls[0].url.includes('/actions/runs/101'))
  assert.equal(calls[0].headers.Authorization, 'Bearer secret-token')

  const withoutToken = githubApi('mysticalsin/AskToto-Mantu', undefined, fetchImpl)
  await withoutToken.run(101)
  assert.equal('Authorization' in calls.at(-1).headers, false)

  assert.equal(await withToken.run(404), null)

  assert.equal(await withToken.isAncestor(SHA1_B, SHA1_A), true)
  assert.ok(calls.at(-1).url.includes(`/compare/${SHA1_B}...${SHA1_A}`))
  assert.equal(await withToken.isAncestor(SHA1_A, SHA1_B), false)
})

test('G2 mergedPullRequests pages until a short page, keeps only merged PRs, and maps head/body/number', async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({
    number: i + 1, merged_at: i % 2 === 0 ? '2026-09-01T00:00:00Z' : null,
    head: { sha: `${i}`.padStart(40, '0') }, body: `pr ${i + 1}`
  }))
  const page2 = [{ number: 101, merged_at: '2026-09-02T00:00:00Z', head: { sha: SHA1_A }, body: 'pr 101' }]
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    const page = new URL(url).searchParams.get('page')
    if (page === '1') return { ok: true, status: 200, json: async () => page1 }
    if (page === '2') return { ok: true, status: 200, json: async () => page2 }
    return { ok: true, status: 200, json: async () => [] }
  }
  const api = githubApi('mysticalsin/AskToto-Mantu', undefined, fetchImpl)
  const merged = await api.mergedPullRequests()
  assert.equal(merged.length, 51)
  assert.ok(merged.every((pr) => pr.number % 2 === 1))
  assert.deepEqual(merged.at(-1), { number: 101, headSha: SHA1_A, body: 'pr 101', mergedAt: '2026-09-02T00:00:00Z' })
  assert.equal(calls.length, 2)
})

test('G3 mergedPullRequests raises on a non-OK response instead of silently truncating', async () => {
  const api = githubApi('mysticalsin/AskToto-Mantu', undefined, async () => ({ ok: false, status: 502, json: async () => [] }))
  await assert.rejects(() => api.mergedPullRequests(), /502/)
})

// --release (M2-0511): the pre-registered release gate rows against the candidate's provenance.
const RELEASE = '1.9.7'
const CANDIDATE_RUN = 9001
const CANDIDATE_COMMIT = '3'.repeat(40)
const LEDGER_COMMIT = '4'.repeat(40)
const SHA_MAC = 'a'.repeat(64)
const SHA_WIN = 'b'.repeat(64)
const SHA_QA = 'c'.repeat(64)
const SHA_BASELINE = 'd'.repeat(64)
const NOTES_PATH = `releases/${RELEASE}.md`
const SAMPLE_PATH = `samples/${RELEASE}.sample.json`
const RELEASE_DEPS = ['M2-0008', 'M2-0029', 'M2-0187', 'M2-0433', 'M2-0489']

const releaseProvenance = (overrides = {}) => ({
  schema: 1,
  repository: 'owner/repo',
  commit: CANDIDATE_COMMIT,
  version: RELEASE,
  run: { id: CANDIDATE_RUN, url: 'https://github.invalid/owner/repo/actions/runs/9001' },
  builds: [
    { variant: 'mac', assets: [{ name: `Metis-${RELEASE}.dmg`, size: 1, sha256: SHA_MAC }] },
    { variant: 'mac-qa-identity', assets: [{ name: `Metis-QA-${RELEASE}.zip`, size: 1, sha256: SHA_QA }] },
    { variant: 'win', assets: [{ name: `Metis-Setup-${RELEASE}.exe`, size: 1, sha256: SHA_WIN }] }
  ],
  ...overrides
})

const releaseGates = () => ({
  schema: 1,
  version: RELEASE,
  rows: [
    { id: 'install-launch', ticket: 'M2-0187', level: 'LIVE_VERIFIED', bytes: 'promotable', hosts: ['macos-latest', 'windows-latest'], accept: 'PASS' },
    { id: 'st1-fifo', ticket: 'M2-0433', level: 'LIVE_VERIFIED', bytes: 'qa-identity', hosts: ['macos-latest'], accept: 'PASS', match: 'st1-fifo/' },
    { id: 'st1-control', ticket: 'M2-0433', level: 'LIVE_VERIFIED', bytes: 'qa-identity', hosts: ['macos-latest'], accept: 'PASS', match: 'st1-control/' },
    { id: 'census', ticket: 'M2-0489', level: 'MEASURED', bytes: 'promotable', hosts: ['macos-latest'], accept: 'PASS' },
    { id: 'freeze-baseline', ticket: 'M2-0008', level: 'LIVE_VERIFIED', bytes: 'baseline', hosts: ['macos-latest'], accept: 'PASS', sha256: [SHA_BASELINE] },
    { id: 'hk-w', ticket: 'M2-0029', level: 'LIVE_VERIFIED', bytes: 'promotable', hosts: ['windows-latest'], accept: 'PASS_OR_STATED' },
    { id: 'renderer-kill', ticket: 'M2-0037', level: 'LIVE_VERIFIED', bytes: 'promotable', hosts: ['macos-latest'], accept: 'REPORT' }
  ],
  sample: { id: 'reexecution-sample', population_of: 'M2-0046', fraction: 0.1, path: SAMPLE_PATH },
  accepted: { id: 'accepted' }
})

const releaseLedger = (statusOf = () => 'DONE') => ({
  tickets: [
    ticket({ id: 'M2-0046', status: 'TODO', depends_on: RELEASE_DEPS, scope_paths: [NOTES_PATH] }),
    ...RELEASE_DEPS.map((id) => ticket({ id, status: statusOf(id) })),
    ticket({ id: 'M2-0037', status: 'TODO' })
  ]
})

function boundRecord(ticketId, host, artifactSha256, overrides = {}) {
  return record({
    ticket: ticketId,
    evidence_level: 'LIVE_VERIFIED',
    environment: { kind: 'hosted-runner', host },
    ci_run_id: 700,
    command: `node scripts/qa/${ticketId}.mjs --host ${host}`,
    output: { path: `evidence/raw/${ticketId}/${host}/result.json`, sha256: 'e'.repeat(64) },
    artifact_sha256: artifactSha256,
    build_run_id: CANDIDATE_RUN,
    ...overrides
  })
}

const reexecutionRecord = (ticketId) => record({ ticket: ticketId, reexecuted_by: session('reexec-1', 'gpt-5.5') })

const acceptedRecord = (text = `Accepted candidate run ${CANDIDATE_RUN}: ${SHA_MAC} and ${SHA_WIN}.`) =>
  record({ ticket: 'M2-0046', evidence_level: 'ACCEPTED', owner_statement: { date: '2026-10-01', text } })

const releaseNotes = (extra = '') => `# Métis ${RELEASE}

Candidate run ${CANDIDATE_RUN}, built from commit ${CANDIDATE_COMMIT}.

| Metis-${RELEASE}.dmg | ${SHA_MAC} |
| Metis-Setup-${RELEASE}.exe | ${SHA_WIN} |

## Residual risks

- None beyond the gate rows.${extra}

## Deferred

- Nothing.
`

function sampleJson(ledgerObject, overrides = {}) {
  const population = populationOf(ledgerObject, 'M2-0046')
  return {
    since: null, populationRule: 'depends-on-closed', of: 'M2-0046', seed: CANDIDATE_COMMIT,
    population, sample: drawSample(population, CANDIDATE_COMMIT, 0.1), ledger_commit: LEDGER_COMMIT, ...overrides
  }
}

function releaseRecords(sampled) {
  return [
    boundRecord('M2-0187', 'macos-latest', SHA_MAC),
    boundRecord('M2-0187', 'windows-latest', SHA_WIN),
    boundRecord('M2-0433', 'macos-latest', SHA_QA, { output: { path: 'evidence/raw/M2-0433/st1-fifo/result.json', sha256: 'e'.repeat(64) } }),
    boundRecord('M2-0433', 'macos-latest', SHA_QA, { output: { path: 'evidence/raw/M2-0433/st1-control/result.json', sha256: 'e'.repeat(64) } }),
    boundRecord('M2-0489', 'macos-latest', SHA_MAC, { evidence_level: 'MEASURED' }),
    boundRecord('M2-0008', 'macos-latest', SHA_BASELINE, { build_run_id: 777 }),
    boundRecord('M2-0029', 'windows-latest', SHA_WIN),
    acceptedRecord(),
    ...sampled.map(reexecutionRecord)
  ]
}

function byTicket(records) {
  const map = new Map()
  for (const r of records) map.set(r.ticket, [...(map.get(r.ticket) ?? []), r])
  return map
}

/** Every releaseProblems argument for a candidate that meets every row; tests mutate one piece. */
function releaseCase() {
  const ledgerObject = releaseLedger()
  const sample = sampleJson(ledgerObject)
  return {
    version: RELEASE,
    gates: releaseGates(),
    provenance: releaseProvenance(),
    ledger: ledgerObject,
    recordsByTicket: byTicket(releaseRecords(sample.sample)),
    notesText: releaseNotes(),
    sample,
    pastLedger: ledgerObject
  }
}

function releaseOf(c) {
  assert.deepEqual(releaseInputProblems(c.gates, c.provenance, c.ledger), [])
  return releaseProblems({
    ...c,
    notesPath: NOTES_PATH,
    readSample(path) {
      assert.equal(path, SAMPLE_PATH)
      return c.sample
    },
    ledgerAt(commit) {
      if (commit !== LEDGER_COMMIT) throw new Error(`unknown commit ${commit}`)
      return c.pastLedger
    }
  })
}

/** Replaces a ticket's gate records, keeping any re-execution record so the sample row stays met. */
function setRecords(c, ticketId, records) {
  c.recordsByTicket.set(ticketId, [...records, ...(c.recordsByTicket.get(ticketId) ?? []).filter((r) => r.reexecuted_by !== undefined)])
}

/** Exactly one problem line, containing every fragment. */
function assertOnlyProblem(problems, ...fragments) {
  assert.equal(problems.length, 1, JSON.stringify(problems))
  assertProblem(problems, ...fragments)
}

test('R1 --release: every row met on the candidate bytes has no problems; a REPORT row is printed, never failed', () => {
  const { problems, reports } = releaseOf(releaseCase())
  assert.deepEqual(problems, [])
  assert.deepEqual(reports, ['REPORT renderer-kill [M2-0037 LIVE_VERIFIED promotable on macos-latest]: no LIVE_VERIFIED record'])
})

test('R2 --release: a PASS bound to another run is reported as bound to that run, not the candidate', () => {
  const c = releaseCase()
  setRecords(c, 'M2-0187', [
    boundRecord('M2-0187', 'macos-latest', SHA_MAC, { build_run_id: 1234 }),
    boundRecord('M2-0187', 'windows-latest', SHA_WIN)
  ])
  assertOnlyProblem(releaseOf(c).problems, 'install-launch', 'macos-latest', 'bound to run 1234, not the candidate')
})

test('R3 --release: a hosted-runner record without ci_run_id does not meet a row', () => {
  const c = releaseCase()
  const { ci_run_id: _dropped, ...withoutRun } = boundRecord('M2-0489', 'macos-latest', SHA_MAC, { evidence_level: 'MEASURED' })
  setRecords(c, 'M2-0489', [withoutRun])
  assertOnlyProblem(releaseOf(c).problems, 'census', 'hosted-runner record with no ci_run_id')
})

test('R4 --release: QA-identity bytes do not meet a row that requires promotable bytes', () => {
  const c = releaseCase()
  setRecords(c, 'M2-0187', [
    boundRecord('M2-0187', 'macos-latest', SHA_QA),
    boundRecord('M2-0187', 'windows-latest', SHA_WIN)
  ])
  assertOnlyProblem(releaseOf(c).problems, 'install-launch', 'macos-latest', 'names qa-identity bytes', 'promotable bytes are required')
})

test('R5 --release: a MEASURED record without build_run_id does not meet a candidate-bound row', () => {
  const c = releaseCase()
  const { build_run_id: _dropped, ...unbound } = boundRecord('M2-0489', 'macos-latest', SHA_MAC, { evidence_level: 'MEASURED' })
  assert.deepEqual(recordProblems(unbound), [], 'record.mjs accepts a MEASURED record without build_run_id')
  setRecords(c, 'M2-0489', [unbound])
  assertOnlyProblem(releaseOf(c).problems, 'census', 'MEASURED', 'no build_run_id')
})

test('R6 --release: rows sharing ticket, level and host are told apart by match; an ambiguous gate file is malformed', () => {
  const c = releaseCase()
  c.recordsByTicket.set('M2-0433', c.recordsByTicket.get('M2-0433').filter((r) => !(r.output?.path ?? '').includes('st1-control/')))
  assertOnlyProblem(releaseOf(c).problems, 'st1-control', 'no LIVE_VERIFIED record matching "st1-control/"')

  // The control record alone must not satisfy the fifo row either.
  const d = releaseCase()
  d.recordsByTicket.set('M2-0433', d.recordsByTicket.get('M2-0433').filter((r) => !(r.output?.path ?? '').includes('st1-fifo/')))
  assertOnlyProblem(releaseOf(d).problems, 'st1-fifo [', 'matching "st1-fifo/"')

  const unmatched = releaseGates()
  delete unmatched.rows[2].match
  assertProblem(releaseInputProblems(unmatched, releaseProvenance(), releaseLedger()), 'st1-fifo, st1-control', 'M2-0433 LIVE_VERIFIED on macos-latest')
  const overlapping = releaseGates()
  overlapping.rows[2].match = 'st1-fifo/control'
  assertProblem(releaseInputProblems(overlapping, releaseProvenance(), releaseLedger()), 'st1-fifo, st1-control')
})

test('R7 --release: a stated row is met by a bound PASS or FAIL, or by a gate:<id> line in the release file', () => {
  const c = releaseCase()
  setRecords(c, 'M2-0029', [])
  assertOnlyProblem(releaseOf(c).problems, 'hk-w', 'no LIVE_VERIFIED record', 'no gate:hk-w line')

  c.notesText = releaseNotes('\n- gate:hk-w-2 is a different row.')
  assertOnlyProblem(releaseOf(c).problems, 'hk-w', 'no gate:hk-w line')

  c.notesText = releaseNotes('\n- gate:hk-w Windows hotkey rows have no hosted-runner result yet.')
  assert.deepEqual(releaseOf(c).problems, [])

  const d = releaseCase()
  setRecords(d, 'M2-0029', [boundRecord('M2-0029', 'windows-latest', SHA_WIN, { result: 'FAIL', exit_code: 1 })])
  assert.deepEqual(releaseOf(d).problems, [])
  setRecords(d, 'M2-0029', [boundRecord('M2-0029', 'windows-latest', SHA_WIN, { result: 'FAIL', exit_code: 1, build_run_id: 1234 })])
  assertOnlyProblem(releaseOf(d).problems, 'hk-w', 'bound to run 1234')
})

test('R8 --release: the sample is recomputed at its ledger_commit, so tickets closing after the draw do not change it', () => {
  const c = releaseCase()
  c.pastLedger = releaseLedger((id) => (id === 'M2-0029' ? 'IN_PROGRESS' : 'DONE'))
  c.sample = sampleJson(c.pastLedger)
  for (const id of c.sample.sample) c.recordsByTicket.set(id, [...(c.recordsByTicket.get(id) ?? []), reexecutionRecord(id)])
  assert.notDeepEqual(populationOf(c.ledger, 'M2-0046'), c.sample.population, 'M2-0029 closed after the draw')
  assert.deepEqual(releaseOf(c).problems, [])
})

test('R9 --release: a sample that differs from the recomputed draw, another seed or a missing re-execution each fail the row', () => {
  const c = releaseCase()
  const other = c.sample.population.find((id) => !c.sample.sample.includes(id))
  c.sample = { ...c.sample, sample: [other] }
  assertOnlyProblem(releaseOf(c).problems, 'reexecution-sample', 'differ from sample.mjs --population-of M2-0046', LEDGER_COMMIT)

  const d = releaseCase()
  d.sample = { ...d.sample, seed: '5'.repeat(40) }
  assertOnlyProblem(releaseOf(d).problems, 'reexecution-sample', 'is not the candidate commit')

  const e = releaseCase()
  const [sampled] = e.sample.sample
  e.recordsByTicket.set(sampled, e.recordsByTicket.get(sampled).filter((r) => r.reexecuted_by === undefined))
  assertOnlyProblem(releaseOf(e).problems, 'reexecution-sample', `R-REEX) for ${sampled}`)

  // A re-execution by the implementer's own model fails R-REEX.
  const f = releaseCase()
  const [fSampled] = f.sample.sample
  f.recordsByTicket.set(fSampled, [...f.recordsByTicket.get(fSampled), record({ ticket: fSampled, reexecuted_by: session('reexec-2') })])
  assertOnlyProblem(releaseOf(f).problems, 'reexecution-sample', fSampled)
})

test('R10 --release: an ACCEPTED record must name the candidate run and every promotable sha256', () => {
  const c = releaseCase()
  c.recordsByTicket.set('M2-0046', [acceptedRecord(`Accepted candidate run ${CANDIDATE_RUN}: ${SHA_MAC}.`)])
  assertOnlyProblem(releaseOf(c).problems, 'accepted [M2-0046 ACCEPTED]', `Metis-Setup-${RELEASE}.exe`)

  c.recordsByTicket.set('M2-0046', [acceptedRecord(`Accepted candidate run ${CANDIDATE_RUN}0: ${SHA_MAC} ${SHA_WIN}.`)])
  assertOnlyProblem(releaseOf(c).problems, 'accepted', `run ${CANDIDATE_RUN}`)

  c.recordsByTicket.delete('M2-0046')
  assertOnlyProblem(releaseOf(c).problems, 'accepted', 'no ACCEPTED record')
})

test('R11 --release: the release file must name the run, the commit and every promotable sha256, with both headings', () => {
  const c = releaseCase()
  c.notesText = releaseNotes().replace('## Deferred', '## Later')
  assertOnlyProblem(releaseOf(c).problems, 'release file', 'missing the heading "Deferred"')

  c.notesText = releaseNotes().replace(CANDIDATE_COMMIT, 'the candidate commit').replace(SHA_WIN, 'pending')
  const { problems } = releaseOf(c)
  assert.equal(problems.length, 2, JSON.stringify(problems))
  assertProblem(problems, 'release file', CANDIDATE_COMMIT)
  assertProblem(problems, 'release file', `Metis-Setup-${RELEASE}.exe`)
})

test('R12 --release: the provenance version, the baseline sha256s and a single release ticket are each required', () => {
  const c = releaseCase()
  c.provenance = releaseProvenance({ version: '1.9.8' })
  assertOnlyProblem(releaseOf(c).problems, 'provenance', '1.9.8 is not 1.9.7')

  const d = releaseCase()
  setRecords(d, 'M2-0008', [boundRecord('M2-0008', 'macos-latest', SHA_MAC)])
  assertOnlyProblem(releaseOf(d).problems, 'freeze-baseline', 'not one of the baseline sha256s')

  const e = releaseCase()
  e.ledger = { tickets: [...e.ledger.tickets, ticket({ id: 'M2-0600', scope_paths: [NOTES_PATH] })] }
  assertOnlyProblem(releaseOf(e).problems, 'accepted', 'exactly one ledger ticket', 'found 2')
})

test('R13 releaseInputProblems rejects a malformed gate file, provenance or ledger', () => {
  const good = [releaseGates(), releaseProvenance(), releaseLedger()]
  assert.deepEqual(releaseInputProblems(...good), [])
  const broken = [
    [{ ...releaseGates(), schema: 2 }, 'gates.schema'],
    [{ ...releaseGates(), rows: [] }, 'gates.rows'],
    [{ ...releaseGates(), rows: [{ ...releaseGates().rows[0], bytes: 'any' }] }, 'bytes'],
    [{ ...releaseGates(), rows: [{ ...releaseGates().rows[4], sha256: [] }] }, 'baseline row'],
    [{ ...releaseGates(), rows: [{ ...releaseGates().rows[0], extra: 1 }] }, 'unexpected key'],
    [{ ...releaseGates(), sample: { id: 'sample', population_of: 'M2-0046', fraction: 0 } }, 'gates.sample'],
    [{ ...releaseGates(), accepted: { id: 'census' } }, 'duplicate row id census']
  ]
  for (const [gates, fragment] of broken) assertProblem(releaseInputProblems(gates, good[1], good[2]), fragment)
  assertProblem(releaseInputProblems(good[0], { ...releaseProvenance(), run: { id: 'x' } }, good[2]), 'provenance.run.id')
  assertProblem(releaseInputProblems(good[0], good[1], {}), 'ledger')
})

test('C32 CLI --release: a met tree exits 0, an unmet row exits 1 one line per problem, bad usage or input exits 2', () => {
  const root = mkdtempSync(join(tmpdir(), 'evidence-release-'))
  for (const dir of ['ledger', 'evidence/records', 'samples', 'releases']) mkdirSync(join(root, ...dir.split('/')), { recursive: true })
  const ledgerPath = join(root, 'ledger', 'tickets.json')
  const ledgerObject = releaseLedger()
  writeFileSync(ledgerPath, JSON.stringify(ledgerObject))
  const git = (...args) => execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim()
  git('init', '-q')
  git('add', 'ledger/tickets.json')
  git('commit', '-q', '-m', 'ledger')
  const ledgerCommit = git('rev-parse', 'HEAD')

  const sample = sampleJson(ledgerObject, { ledger_commit: ledgerCommit })
  writeFileSync(join(root, ...SAMPLE_PATH.split('/')), JSON.stringify(sample))
  for (const [id, list] of byTicket(releaseRecords(sample.sample))) {
    writeFileSync(join(root, 'evidence', 'records', `${id}.jsonl`), list.map((r) => `${JSON.stringify(r)}\n`).join(''))
  }
  const notesPath = join(root, ...NOTES_PATH.split('/'))
  const gatesPath = join(root, 'gates.json')
  const provenancePath = join(root, 'provenance.json')
  writeFileSync(notesPath, releaseNotes())
  writeFileSync(gatesPath, JSON.stringify(releaseGates()))
  writeFileSync(provenancePath, JSON.stringify(releaseProvenance()))

  const cliPath = fileURLToPath(new URL('./check.mjs', import.meta.url))
  const releaseArgs = ['--release', RELEASE, '--gates', gatesPath, '--provenance', provenancePath, '--ledger', ledgerPath, '--notes', notesPath]
  const run = (args) => execFileSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', stdio: 'pipe' })
  const ok = run(releaseArgs)
  assert.match(ok, /release 1\.9\.7: OK/)
  assert.match(ok, /REPORT renderer-kill/)

  writeFileSync(notesPath, releaseNotes().replace('## Deferred', '## Later').replace(CANDIDATE_COMMIT, 'the commit'))
  assert.throws(() => run(releaseArgs), (error) => {
    assert.equal(error.status, 1)
    assert.deepEqual(error.stderr.trim().split(/\r?\n/).sort(), [
      `- release file: does not name the commit ${CANDIDATE_COMMIT}`,
      '- release file: missing the heading "Deferred"'
    ])
    return true
  })
  writeFileSync(notesPath, releaseNotes())

  // A later hosted-runner record without ci_run_id is malformed input, not skipped for the older PASS.
  const censusPath = join(root, 'evidence', 'records', 'M2-0489.jsonl')
  const censusRecords = readFileSync(censusPath, 'utf8')
  const { ci_run_id: _dropped, ...unrun } = boundRecord('M2-0489', 'macos-latest', SHA_MAC, { evidence_level: 'MEASURED' })
  writeFileSync(censusPath, `${censusRecords}${JSON.stringify(unrun)}\n`)
  assert.throws(() => run(releaseArgs), (error) => {
    assert.equal(error.status, 2)
    assert.match(error.stderr, /records\/M2-0489\.jsonl:\d+: ci_run_id: required for a hosted-runner MEASURED record/)
    return true
  })
  writeFileSync(censusPath, censusRecords)
  assert.match(run(releaseArgs), /release 1\.9\.7: OK/)

  for (const args of [
    releaseArgs.slice(0, -2),
    [...releaseArgs, '--pr-event', gatesPath],
    ['--ledger', ledgerPath, '--gates', gatesPath],
    ['--release', RELEASE, '--unknown', 'x']
  ]) {
    assert.throws(() => run(args), (error) => error.status === 2)
  }
  const usage = /--release <version> --gates <gates\.json> --provenance <provenance\.json> --ledger <tickets\.json> --notes/
  assert.throws(() => run([]), (error) => error.status === 2 && usage.test(error.stderr))

  writeFileSync(gatesPath, JSON.stringify({ schema: 1 }))
  assert.throws(() => run(releaseArgs), (error) => error.status === 2 && /gates\.rows/.test(error.stderr))
  writeFileSync(gatesPath, '{')
  assert.throws(() => run(releaseArgs), (error) => error.status === 2)
  rmSync(root, { recursive: true, force: true })
})
