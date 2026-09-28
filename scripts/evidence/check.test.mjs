import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RECORD_SCHEMA } from './record.mjs'
import { TEST_WORKFLOW, ledgerProblems, outputProblems, prProblems, githubApi } from './check.mjs'

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
