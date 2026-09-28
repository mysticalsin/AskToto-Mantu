import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RECORD_SCHEMA } from './record.mjs'
import { TEST_WORKFLOW } from './check.mjs'
import { closedSince } from './sample.mjs'
import {
  DEFAULT_OUT,
  buildBackfill,
  earliestRecordedAt,
  requiredLevelsFor,
  resolveBackfill,
  verifiedRecordsByTicket,
  writeBackfill
} from './backfill.mjs'

const SHA1_A = '1'.repeat(40)
const SHA1_B = '2'.repeat(40)
const session = (id, model = 'claude-sonnet-5') => ({ model, id })

function ticket(overrides = {}) {
  return {
    id: 'M2-0001', status: 'TODO', type: 'feature', depends_on: [], needs_decision: [],
    kit_refs: [], finding_refs: [], slices: [], estimate_hours: 4,
    required_evidence: ['LOCALLY_TESTED'], external_blocker: null, flag: null,
    ...overrides
  }
}

function record(overrides = {}) {
  return {
    schema: RECORD_SCHEMA, ticket: 'M2-0001', evidence_level: 'LOCALLY_TESTED',
    recorded_at: '2026-09-20T00:00:00Z', kit_refs: {}, finding_refs: [],
    commit: SHA1_A, result: 'PASS', implementer_session: session('impl-1'),
    validator_session: session('valid-1'), pr: 1, ci_run_id: 1,
    environment: { kind: 'ci', host: 'ubuntu-latest' }, command: 'npm test', exit_code: 0,
    ...overrides
  }
}

const evidenceBody = (...records) =>
  records.map((r) => `\`\`\`json evidence\n${JSON.stringify(r)}\n\`\`\`\n`).join('\n')

const greenRun = Object.freeze({ path: TEST_WORKFLOW, head_sha: SHA1_A, status: 'completed', conclusion: 'success' })

function pr({ number, headSha = SHA1_A, body, mergedAt }) {
  return { number, headSha, body, mergedAt }
}

function fakeGithub({ runs = {} } = {}) {
  return {
    async run(id) {
      return runs[id] ?? null
    },
    async isAncestor() {
      return true
    }
  }
}

test('requiredLevelsFor: DONE needs every required level, ENGINEERING_COMPLETE only the in-house ones, others none', () => {
  assert.deepEqual(
    requiredLevelsFor(ticket({ status: 'DONE', required_evidence: ['LOCALLY_TESTED', 'LIVE_VERIFIED'] })),
    ['LOCALLY_TESTED', 'LIVE_VERIFIED']
  )
  assert.deepEqual(
    requiredLevelsFor(ticket({ status: 'ENGINEERING_COMPLETE', required_evidence: ['LOCALLY_TESTED', 'LIVE_VERIFIED'] })),
    ['LOCALLY_TESTED']
  )
  assert.deepEqual(requiredLevelsFor(ticket({ status: 'IN_PROGRESS', required_evidence: ['LOCALLY_TESTED'] })), [])
})

test('verifiedRecordsByTicket: only PRs whose evidence verifies contribute records, grouped by ticket', async () => {
  const validPr = pr({
    number: 1, headSha: SHA1_A, mergedAt: '2026-09-01T00:00:00Z',
    body: evidenceBody(record({ ticket: 'M2-0001', commit: SHA1_A, pr: 1, ci_run_id: 101 }))
  })
  const staleCommitPr = pr({
    number: 2, headSha: SHA1_B, mergedAt: '2026-09-02T00:00:00Z',
    body: evidenceBody(record({ ticket: 'M2-0002', commit: SHA1_A, pr: 2, ci_run_id: 101 })) // commit != this PR's headSha
  })
  const noEvidencePr = pr({ number: 3, headSha: SHA1_A, mergedAt: '2026-09-03T00:00:00Z', body: 'nothing here' })

  const { recordsByTicket, prProblems } = await verifiedRecordsByTicket(
    [validPr, staleCommitPr, noEvidencePr],
    { github: fakeGithub({ runs: { 101: greenRun } }), fileExists: () => true }
  )

  assert.equal(recordsByTicket.has('M2-0001'), true)
  assert.equal(recordsByTicket.has('M2-0002'), false)
  assert.equal(recordsByTicket.has('M2-0003'), false)
  assert.ok(prProblems.get(2).length > 0)
  assert.equal(prProblems.has(3), false) // no evidence block means no verification attempt
})

test('resolveBackfill: a DONE ticket with a verified PASS for its required level backfills clean', () => {
  const t = ticket({ id: 'M2-0001', status: 'DONE', required_evidence: ['LOCALLY_TESTED'] })
  const recordsByTicket = new Map([['M2-0001', [record({ ticket: 'M2-0001' })]]])
  const { backfilled, gaps } = resolveBackfill({ tickets: [t] }, recordsByTicket)
  assert.deepEqual(gaps, [])
  assert.deepEqual(backfilled.get('M2-0001').map((r) => r.evidence_level), ['LOCALLY_TESTED'])
})

test('resolveBackfill: a DONE ticket with no verified record for a required level is a gap, not backfilled for that level', () => {
  const t = ticket({ id: 'M2-0001', status: 'DONE', required_evidence: ['LOCALLY_TESTED', 'MEASURED'] })
  const recordsByTicket = new Map([['M2-0001', [record({ ticket: 'M2-0001' })]]])
  const { gaps } = resolveBackfill({ tickets: [t] }, recordsByTicket)
  assert.equal(gaps.length, 1)
  assert.equal(gaps[0].ticket, 'M2-0001')
  assert.equal(gaps[0].level, 'MEASURED')
  // MEASURED is not an in-house level and LOCALLY_TESTED still has a verified PASS, so this ticket has a floor.
  assert.equal(gaps[0].target_status, 'ENGINEERING_COMPLETE')
})

test('resolveBackfill: latest record governs — a later verified FAIL withdraws an earlier verified PASS', () => {
  const t = ticket({ id: 'M2-0001', status: 'DONE', required_evidence: ['LOCALLY_TESTED'] })
  const recordsByTicket = new Map([[
    'M2-0001',
    [record({ ticket: 'M2-0001', result: 'PASS' }), record({ ticket: 'M2-0001', result: 'FAIL', exit_code: 1 })]
  ]])
  const { backfilled, gaps } = resolveBackfill({ tickets: [t] }, recordsByTicket)
  assert.equal(gaps.length, 1)
  assert.equal(backfilled.get('M2-0001')[0].result, 'FAIL')
  // LOCALLY_TESTED is in-house and it is the one that failed, so this ticket has no floor.
  assert.equal(gaps[0].target_status, 'IN_PROGRESS')
})

test('resolveBackfill: an ENGINEERING_COMPLETE ticket is not gapped on a level it does not need in-house', () => {
  const t = ticket({ id: 'M2-0001', status: 'ENGINEERING_COMPLETE', required_evidence: ['LOCALLY_TESTED', 'LIVE_VERIFIED'] })
  const recordsByTicket = new Map([['M2-0001', [record({ ticket: 'M2-0001' })]]])
  const { gaps } = resolveBackfill({ tickets: [t] }, recordsByTicket)
  assert.deepEqual(gaps, [])
})

test('resolveBackfill: TODO/IN_PROGRESS tickets are ignored even with records present', () => {
  const t = ticket({ id: 'M2-0001', status: 'IN_PROGRESS' })
  const recordsByTicket = new Map([['M2-0001', [record({ ticket: 'M2-0001' })]]])
  const { backfilled, gaps } = resolveBackfill({ tickets: [t] }, recordsByTicket)
  assert.equal(backfilled.size, 0)
  assert.deepEqual(gaps, [])
})

test('buildBackfill end-to-end: verifies PR bodies, then resolves gaps against the ledger', async () => {
  const t1 = ticket({ id: 'M2-0001', status: 'DONE', required_evidence: ['LOCALLY_TESTED'] })
  const t2 = ticket({ id: 'M2-0002', status: 'DONE', required_evidence: ['LOCALLY_TESTED'] })
  const prs = [
    pr({ number: 1, headSha: SHA1_A, mergedAt: '2026-09-01T00:00:00Z', body: evidenceBody(record({ ticket: 'M2-0001', pr: 1, ci_run_id: 101 })) })
  ]
  const result = await buildBackfill({
    ledger: { tickets: [t1, t2] }, prs, github: fakeGithub({ runs: { 101: greenRun } }), fileExists: () => true
  })
  assert.equal(result.backfilled.has('M2-0001'), true)
  assert.equal(result.backfilled.has('M2-0002'), false)
  assert.deepEqual(result.gaps, [{
    ticket: 'M2-0002', status: 'DONE', level: 'LOCALLY_TESTED',
    reason: 'no verified PR evidence found for this level', target_status: 'IN_PROGRESS'
  }])
})

test('writeBackfill writes one JSONL file per backfilled ticket, a gaps.jsonl and a lead-action README', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'evidence-backfill-'))
  const backfilled = new Map([['M2-0001', [record({ ticket: 'M2-0001' })]]])
  const gaps = [{
    ticket: 'M2-0002', status: 'DONE', level: 'MEASURED',
    reason: 'no verified PR evidence found for this level', target_status: 'ENGINEERING_COMPLETE'
  }]

  writeBackfill(outDir, { backfilled, gaps })

  const recordLines = readFileSync(join(outDir, 'records', 'M2-0001.jsonl'), 'utf8').trim().split('\n')
  assert.equal(recordLines.length, 1)
  assert.equal(JSON.parse(recordLines[0]).ticket, 'M2-0001')

  const gapLines = readFileSync(join(outDir, 'gaps.jsonl'), 'utf8').trim().split('\n')
  assert.equal(JSON.parse(gapLines[0]).ticket, 'M2-0002')

  const readme = readFileSync(join(outDir, 'README.md'), 'utf8')
  assert.match(readme, /LEAD_ACTION: file these records/)
  assert.match(readme, /M2-0001/)
  assert.match(readme, /LEAD_ACTION: revert tickets with no verified evidence/)
  // the target status the lead should revert the gap ticket to, not just that a gap exists
  assert.match(readme, /M2-0002 \[DONE -> ENGINEERING_COMPLETE\]/)
  assert.match(readme, /M2-0047 and M2-0144/)
  // known limitation: wired/repro existence checks run against this checkout's HEAD, not the PR's own commit
  assert.match(readme, /current HEAD, not each PR's own commit/)

  assert.deepEqual(readdirSync(outDir).sort(), ['README.md', 'gaps.jsonl', 'records'])
})

test('earliestRecordedAt: the oldest recorded_at across every backfilled ticket, string order not insertion order', () => {
  const backfilled = new Map([
    ['M2-0002', [record({ ticket: 'M2-0002', recorded_at: '2026-09-15T00:00:00Z' })]],
    ['M2-0001', [record({ ticket: 'M2-0001', recorded_at: '2026-06-01T12:00:00Z' })]]
  ])
  assert.equal(earliestRecordedAt(backfilled), '2026-06-01T12:00:00Z')
  assert.equal(earliestRecordedAt(new Map()), null)
})

test("README's re-execution sample instruction uses a --since that keeps the whole back-filled population " +
  "(sample.mjs's closedSince drops any ticket whose newest record predates --since)", () => {
  const outDir = mkdtempSync(join(tmpdir(), 'evidence-backfill-'))
  const backfilled = new Map([
    // both PR-dated well before any plausible "previous gate date" a lead might otherwise type in
    ['M2-0001', [record({ ticket: 'M2-0001', recorded_at: '2026-01-10T00:00:00Z' })]],
    ['M2-0002', [record({ ticket: 'M2-0002', recorded_at: '2026-03-05T00:00:00Z' })]]
  ])

  writeBackfill(outDir, { backfilled, gaps: [] })
  const readme = readFileSync(join(outDir, 'README.md'), 'utf8')

  const sinceMatch = readme.match(/--since (\S+)/)
  assert.ok(sinceMatch, 'README must give a concrete --since instant, not a placeholder the lead has to guess')
  const since = sinceMatch[1]

  const ledger = { tickets: [...backfilled.keys()].map((id) => ticket({ id, status: 'DONE' })) }
  const population = closedSince(ledger, backfilled, since)
  assert.deepEqual(population.sort(), ['M2-0001', 'M2-0002'])
})

test('CLI: missing --repo or an unreadable ledger exits 2 with a usage message, before any network call', () => {
  const cliPath = fileURLToPath(new URL('./backfill.mjs', import.meta.url))
  const root = mkdtempSync(join(tmpdir(), 'evidence-backfill-cli-'))
  const ledgerPath = join(root, 'tickets.json')
  writeFileSync(ledgerPath, JSON.stringify({ tickets: [] }))

  assert.throws(
    () => execFileSync(process.execPath, [cliPath, '--ledger', ledgerPath], { encoding: 'utf8', stdio: 'pipe' }),
    { status: 2 }
  )
  assert.throws(
    () => execFileSync(
      process.execPath,
      [cliPath, '--ledger', join(root, 'missing.json'), '--repo', 'mysticalsin/AskToto-Mantu'],
      { encoding: 'utf8', stdio: 'pipe' }
    ),
    { status: 2 }
  )
})

test('DEFAULT_OUT is a git-ignored out/ path, not a program-repository path', () => {
  assert.match(DEFAULT_OUT, /^out\//)
})
