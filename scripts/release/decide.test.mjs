import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RECORD_SCHEMA } from '../evidence/record.mjs'
import { lintContract } from './contract-lint.mjs'
import { decide, gitForeignChanges, publicReport, renderMarkdown, renderPublicMarkdown } from './decide.mjs'

const SHA1 = '1'.repeat(40)
const DECIDE = fileURLToPath(new URL('./decide.mjs', import.meta.url))

const session = (id) => ({ model: 'claude-sonnet-5', id })

function ticket(overrides = {}) {
  return {
    id: 'M2-0001',
    status: 'DONE',
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
    scope_paths: ['src/a.ts'],
    ...overrides
  }
}

function record(overrides = {}) {
  return {
    schema: RECORD_SCHEMA,
    ticket: 'M2-0001',
    evidence_level: 'LOCALLY_TESTED',
    recorded_at: '2026-09-26T00:00:00Z',
    kit_refs: {},
    finding_refs: [],
    commit: SHA1,
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

const blocker = { owner: 'owner', unblock_step: 'Provide the outside account', needed_by: 'M2-0300', raised_on: '2026-09-01' }
const matrix = (rows = [{ id: 'REQ-1', tickets: ['M2-0001'] }]) => ({ rows })
const noChanges = () => []

function lint({ tickets = [ticket()], records = [record()], mx = matrix(), foreignChanges = noChanges, decisions } = {}) {
  const recordsByTicket = new Map()
  for (const r of records) recordsByTicket.set(r.ticket, [...(recordsByTicket.get(r.ticket) ?? []), r])
  return lintContract({ ledger: decisions ? { tickets, decisions } : { tickets }, recordsByTicket, matrix: mx, foreignChanges })
}

const failing = (report) => report.checks.filter((c) => c.status === 'FAIL').map((c) => c.id)

test('a fully receipted ledger and matrix pass all ten checks', () => {
  const report = lint()
  assert.equal(report.checks.length, 10)
  assert.deepEqual(failing(report), [])
  assert.equal(report.engineering, 'COMPLETE')
  assert.equal(report.real_environment, 'COMPLETE')
})

test('an open ticket fails S27-03', () => {
  assert.ok(failing(lint({ tickets: [ticket({ status: 'IN_PROGRESS' })], records: [] })).includes('S27-03'))
})

test('a DONE ticket with no receipt is listed as missing and fails S27-04', () => {
  const report = lint({ records: [] })
  assert.deepEqual(report.missing, [{ ticket: 'M2-0001', level: 'LOCALLY_TESTED', reason: 'no record' }])
  assert.ok(failing(report).includes('S27-04'))
})

test('a withdrawn receipt (latest record FAIL) fails S27-06 and is missing', () => {
  const report = lint({ records: [record(), record({ result: 'FAIL', recorded_at: '2026-09-27T00:00:00Z' })] })
  assert.ok(failing(report).includes('S27-06'))
  assert.equal(report.missing[0].reason, 'latest record is not PASS')
})

test('a receipt older than a foreign change to the ticket scope is stale and fails S27-05', () => {
  const seen = []
  const report = lint({
    foreignChanges: (query) => {
      seen.push(query)
      return ['abc1234']
    }
  })
  assert.deepEqual(report.stale, [{ ticket: 'M2-0001', level: 'LOCALLY_TESTED', recorded_at: '2026-09-26T00:00:00Z', changed_by: ['abc1234'] }])
  assert.ok(failing(report).includes('S27-05'))
  assert.deepEqual(seen[0].paths, ['src/a.ts'])
  assert.equal(seen[0].ticket, 'M2-0001')
})

test('BLOCKED_EXTERNAL rows are listed with their unblock step; PASS stays engineering-only', () => {
  const blocked = ticket({ id: 'M2-0002', status: 'BLOCKED_EXTERNAL', external_blocker: blocker, required_evidence: ['LIVE_VERIFIED'] })
  const report = lint({ tickets: [ticket(), blocked], mx: matrix([{ id: 'REQ-1', tickets: ['M2-0001', 'M2-0002'] }]) })
  assert.deepEqual(failing(report), [])
  assert.equal(report.real_environment, 'BLOCKED')
  assert.equal(report.blocked[0].unblock_step, 'Provide the outside account')
  assert.match(renderMarkdown({ decision: 'PASS', commit: SHA1, input_problems: [], ...report }), /unblock: Provide the outside account/)
})

test('a BLOCKED_EXTERNAL row without an unblock step fails S27-08', () => {
  const blocked = ticket({ id: 'M2-0002', status: 'BLOCKED_EXTERNAL', external_blocker: { ...blocker, unblock_step: '' }, required_evidence: ['LIVE_VERIFIED'] })
  assert.ok(failing(lint({ tickets: [ticket(), blocked] })).includes('S27-08'))
})

test('a DONE receipt reporting a PARTIAL kit ref fails S27-07', () => {
  const t = ticket({ kit_refs: ['K-1'] })
  assert.ok(failing(lint({ tickets: [t], records: [record({ kit_refs: { 'K-1': 'PARTIAL' } })] })).includes('S27-07'))
})

test('a DONE ticket on an OPEN decision fails S27-09', () => {
  const t = ticket({ needs_decision: ['D-1'] })
  assert.ok(failing(lint({ tickets: [t], records: [record({ assumed_decisions: ['D-1'] })], decisions: { 'D-1': 'OPEN' } })).includes('S27-09'))
})

test('matrix rows with no ticket, an unknown ticket or a CANCELLED ticket fail S27-10', () => {
  const cancelled = ticket({ id: 'M2-0003', status: 'CANCELLED', reason: 'superseded', required_evidence: ['DESIGNED'] })
  const mx = matrix([{ id: 'A', tickets: [] }, { id: 'B', tickets: ['M2-9999'] }, { id: 'C', tickets: ['M2-0003'] }])
  const report = lint({ tickets: [ticket(), cancelled], mx })
  const check = report.checks.find((c) => c.id === 'S27-10')
  assert.equal(check.problems.length, 3)
})

test('a malformed matrix fails S27-10 instead of throwing', () => {
  assert.ok(failing(lint({ mx: {} })).includes('S27-10'))
})

test('receipt store problems fail S27-01', () => {
  const report = lintContract({ ledger: { tickets: [ticket()] }, recordsByTicket: new Map([['M2-0001', [record()]]]), storeProblems: ['records/M2-0001.jsonl:1: bad'], matrix: matrix(), foreignChanges: noChanges })
  assert.ok(failing(report).includes('S27-01'))
})

function programFixture({ withRecords = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'release-decide-'))
  mkdirSync(join(root, 'ledger'))
  mkdirSync(join(root, 'evidence', 'records'), { recursive: true })
  writeFileSync(join(root, 'ledger', 'tickets.json'), JSON.stringify({ tickets: [ticket()] }))
  writeFileSync(join(root, 'matrix.json'), JSON.stringify(matrix()))
  if (withRecords) writeFileSync(join(root, 'evidence', 'records', 'M2-0001.jsonl'), `${JSON.stringify(record())}\n`)
  return root
}

test('decide reads the record store next to the ledger and returns PASS', () => {
  const root = programFixture()
  const decision = decide({ ledgerPath: join(root, 'ledger', 'tickets.json'), matrixPath: join(root, 'matrix.json'), releaseCommit: SHA1, foreignChanges: noChanges })
  assert.equal(decision.decision, 'PASS')
  assert.equal(decision.commit, SHA1)
})

test('decide returns FAIL when the ticket has no receipt file', () => {
  const root = programFixture({ withRecords: false })
  const decision = decide({ ledgerPath: join(root, 'ledger', 'tickets.json'), matrixPath: join(root, 'matrix.json'), releaseCommit: SHA1, foreignChanges: noChanges })
  assert.equal(decision.decision, 'FAIL')
  assert.equal(decision.missing.length, 1)
})

test('decide fails, rather than skips, when the ledger is absent', () => {
  const root = programFixture()
  const decision = decide({ ledgerPath: join(root, 'nope.json'), matrixPath: join(root, 'matrix.json'), releaseCommit: SHA1, foreignChanges: noChanges })
  assert.equal(decision.decision, 'FAIL')
  assert.match(decision.input_problems[0], /not found/)
})

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim()
}

test('gitForeignChanges ignores commits naming the ticket and reports the rest', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'release-git-'))
  git(cwd, 'init', '-q')
  mkdirSync(join(cwd, 'src'))
  writeFileSync(join(cwd, 'src', 'a.ts'), '1')
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-q', '-m', 'feat: first [M2-0001]')
  writeFileSync(join(cwd, 'src', 'a.ts'), '2')
  git(cwd, 'commit', '-q', '-am', 'fix: other ticket touches it [M2-0002]')
  writeFileSync(join(cwd, 'src', 'a.ts'), '3')
  git(cwd, 'commit', '-q', '-am', 'fix: own follow-up [M2-0001]')
  const head = git(cwd, 'rev-parse', 'HEAD')
  const changes = gitForeignChanges({ cwd, releaseCommit: head })({ paths: ['src/a.ts'], since: '2000-01-01T00:00:00Z', ticket: 'M2-0001' })
  assert.equal(changes.length, 1)
  assert.equal(git(cwd, 'log', '-1', '--format=%s', changes[0]), 'fix: other ticket touches it [M2-0002]')
})

test('the CLI writes the decision files and exits 1 on FAIL', () => {
  const root = programFixture({ withRecords: false })
  const out = join(root, 'out')
  assert.throws(
    () => execFileSync(process.execPath, [DECIDE, '--commit', 'HEAD', '--ledger', join(root, 'ledger', 'tickets.json'), '--matrix', join(root, 'matrix.json'), '--out', out], { stdio: 'pipe' }),
    (error) => error.status === 1
  )
  assert.equal(JSON.parse(readFileSync(join(out, 'release-decision.json'), 'utf8')).decision, 'FAIL')
  assert.match(readFileSync(join(out, 'release-decision.md'), 'utf8'), /# Release decision: FAIL/)
})

test('a dependent ENGINEERING_COMPLETE row resolves to its root blocker unblock step', () => {
  const root = ticket({ id: 'M2-0002', status: 'BLOCKED_EXTERNAL', external_blocker: blocker, required_evidence: ['LIVE_VERIFIED'] })
  const dependent = ticket({ id: 'M2-0003', status: 'ENGINEERING_COMPLETE', depends_on: ['M2-0002'], required_evidence: ['LOCALLY_TESTED'] })
  const report = lint({
    tickets: [ticket(), root, dependent],
    records: [record(), record({ ticket: 'M2-0003' })],
    mx: matrix([{ id: 'REQ-1', tickets: ['M2-0001', 'M2-0003'] }])
  })
  const row = report.blocked.find((b) => b.ticket === 'M2-0003')
  assert.equal(row.via, 'M2-0002')
  assert.equal(row.unblock_step, 'Provide the outside account')
  assert.match(renderMarkdown({ decision: 'PASS', commit: SHA1, input_problems: [], ...report }), /M2-0003 \(ENGINEERING_COMPLETE, via M2-0002\): owner owner; unblock: Provide the outside account/)
})

test('an ENGINEERING_COMPLETE row with no root blocker is reported as waiting on a lead action', () => {
  const report = lint({ tickets: [ticket({ status: 'ENGINEERING_COMPLETE' })] })
  assert.equal(report.blocked[0].via, null)
  assert.match(renderMarkdown({ decision: 'PASS', commit: SHA1, input_problems: [], ...report }), /waiting on a lead action/)
})

test('a dependency on an unknown ticket fails S27-02', () => {
  assert.ok(failing(lint({ tickets: [ticket({ depends_on: ['M2-9999'] })] })).includes('S27-02'))
})

test('the public report carries ids, statuses and counts only, never ledger text', () => {
  const secretRef = 'FINDING-SECRET-7'
  const secretStep = 'Ask the vendor contact for the sandbox key'
  const blocked = ticket({
    id: 'M2-0002',
    status: 'BLOCKED_EXTERNAL',
    finding_refs: [secretRef],
    external_blocker: { ...blocker, owner: 'someone-private', unblock_step: secretStep },
    required_evidence: ['LIVE_VERIFIED']
  })
  const t = ticket({ kit_refs: ['K-1'], finding_refs: [secretRef] })
  const report = lint({
    tickets: [t, blocked],
    records: [record({ kit_refs: { 'K-1': 'NOT_MET' }, finding_refs: [secretRef] })],
    mx: matrix([{ id: 'REQ-1', tickets: ['M2-0001', 'M2-0002'] }])
  })
  const full = { decision: 'FAIL', commit: SHA1, input_problems: [], ...report }
  assert.ok(JSON.stringify(full).includes(secretStep), 'the detail report keeps the unblock step')
  const publicDoc = publicReport(full)
  const text = `${JSON.stringify(publicDoc)}\n${renderPublicMarkdown(publicDoc)}`
  for (const secret of [secretRef, secretStep, 'someone-private', 'NOT_MET', 'K-1']) assert.ok(!text.includes(secret), `${secret} leaked`)
  assert.deepEqual(publicDoc.blocked, { count: 1, tickets: ['M2-0002'] })
  assert.ok(publicDoc.checks.some((c) => c.id === 'S27-07' && c.status === 'FAIL' && c.problem_count === 1))
})

test('the CLI writes only the public report to --out and the full one to --detail-out', () => {
  const root = programFixture({ withRecords: false })
  const out = join(root, 'out')
  const detail = join(root, 'detail')
  assert.throws(
    () => execFileSync(process.execPath, [DECIDE, '--commit', 'HEAD', '--ledger', join(root, 'ledger', 'tickets.json'), '--matrix', join(root, 'matrix.json'), '--out', out, '--detail-out', detail], { stdio: 'pipe' }),
    (error) => error.status === 1
  )
  const publicDoc = JSON.parse(readFileSync(join(out, 'release-decision.json'), 'utf8'))
  assert.equal(publicDoc.problems, undefined)
  assert.equal(publicDoc.missing.count, 1)
  assert.equal(JSON.parse(readFileSync(join(detail, 'release-decision.json'), 'utf8')).missing[0].reason, 'no record')
})
