import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  RECORD_SCHEMA,
  recordProblems,
  parseRecordLines,
  recordsInPrBody,
  latestByLevel,
  readRecordStore
} from './record.mjs'

const SHA1_A = '1'.repeat(40)
const SHA1_B = '2'.repeat(40)
const SHA256_A = 'a'.repeat(64)

const session = (id, model = 'claude-sonnet-5') => ({ model, id })

function base(overrides = {}) {
  return {
    schema: RECORD_SCHEMA,
    ticket: 'M2-0002',
    evidence_level: 'DESIGNED',
    recorded_at: '2026-09-26T00:00:00Z',
    kit_refs: { 'M2-REL-01': 'PARTIAL' },
    finding_refs: ['CHATGPT-A10'],
    commit: SHA1_A,
    result: 'PASS',
    implementer_session: session('impl-1'),
    validator_session: session('valid-1'),
    ...overrides
  }
}

const designed = (overrides = {}) => base({ evidence_level: 'DESIGNED', pr: 42, ...overrides })
const locallyTested = (overrides = {}) => base({
  evidence_level: 'LOCALLY_TESTED',
  pr: 42,
  ci_run_id: 101,
  environment: { kind: 'ci', host: 'ubuntu-latest' },
  command: 'npm test',
  exit_code: 0,
  ...overrides
})
const hostConfigured = (overrides = {}) => base({
  evidence_level: 'HOST_CONFIGURED',
  environment: { kind: 'qa-mac', host: 'qa-mac-1' },
  command: 'npm run check:build-host',
  exit_code: 0,
  output: { path: 'evidence/raw/M2-0002/host.json', sha256: SHA256_A },
  ...overrides
})
const liveVerified = (overrides = {}) => base({
  evidence_level: 'LIVE_VERIFIED',
  artifact_sha256: SHA256_A,
  build_run_id: 202,
  environment: { kind: 'qa-mac', host: 'qa-mac-1' },
  command: 'npm run check:packaged-launch',
  exit_code: 0,
  output: { path: 'evidence/raw/M2-0002/launch.json', sha256: SHA256_A },
  ...overrides
})
const measured = (overrides = {}) => base({
  evidence_level: 'MEASURED',
  environment: { kind: 'ci', host: 'ubuntu-latest' },
  command: 'node scripts/bench-llm-client.mjs',
  exit_code: 0,
  output: { path: 'evidence/raw/M2-0002/bench.json', sha256: SHA256_A },
  ...overrides
})
const accepted = (overrides = {}) => base({
  evidence_level: 'ACCEPTED',
  owner_statement: { date: '2026-09-26', text: 'Approved shipping flag-off under D-14.' },
  ...overrides
})

function assertProblem(problems, ...fragments) {
  const found = problems.some((p) => fragments.every((f) => p.includes(f)))
  assert.ok(found, `expected a problem containing ${JSON.stringify(fragments)} in ${JSON.stringify(problems)}`)
}

test('R1 a complete record at each of the six levels has no problems', () => {
  for (const build of [designed, locallyTested, hostConfigured, liveVerified, measured, accepted]) {
    assert.deepEqual(recordProblems(build()), [])
  }
})

test('R2 an unknown key is rejected and named', () => {
  assertProblem(recordProblems({ ...locallyTested(), bogus: true }), 'bogus', 'unexpected key')
})

test('R3 each ALWAYS field missing yields a problem naming it', () => {
  for (const field of ['schema', 'ticket', 'evidence_level', 'recorded_at', 'kit_refs', 'finding_refs',
    'commit', 'result', 'implementer_session', 'validator_session']) {
    const record = locallyTested()
    delete record[field]
    assertProblem(recordProblems(record), field, 'required')
  }
})

test('R4 an unknown or miscased evidence_level is rejected', () => {
  assertProblem(recordProblems(base({ evidence_level: 'VERIFIED' })), 'evidence_level')
  assertProblem(recordProblems(base({ evidence_level: 'locally_tested' })), 'evidence_level')
})

test('R5 removing a level-required field yields a problem naming it', () => {
  const requires = {
    DESIGNED: [],
    LOCALLY_TESTED: ['pr', 'ci_run_id', 'environment', 'command', 'exit_code'],
    HOST_CONFIGURED: ['environment', 'command', 'exit_code', 'output'],
    LIVE_VERIFIED: ['artifact_sha256', 'build_run_id', 'environment', 'command', 'exit_code', 'output'],
    MEASURED: ['environment', 'command', 'exit_code', 'output'],
    ACCEPTED: ['owner_statement']
  }
  const builders = { DESIGNED: designed, LOCALLY_TESTED: locallyTested, HOST_CONFIGURED: hostConfigured,
    LIVE_VERIFIED: liveVerified, MEASURED: measured, ACCEPTED: accepted }
  for (const [level, fields] of Object.entries(requires)) {
    for (const field of fields) {
      const record = builders[level]()
      delete record[field]
      assertProblem(recordProblems(record), field)
    }
  }
})

test('R6 environment.kind must match the level: in-house only for LOCALLY_TESTED, never ci on a host', () => {
  assertProblem(recordProblems(locallyTested({ environment: { kind: 'qa-mac', host: 'qa-mac-1' } })), 'environment.kind')
  assertProblem(recordProblems(hostConfigured({ environment: { kind: 'ci', host: 'ubuntu-latest' } })), 'environment.kind')
  assertProblem(recordProblems(liveVerified({ environment: { kind: 'ci', host: 'ubuntu-latest' } })), 'environment.kind')
})

test('R7 the same session id as implementer and validator is rejected', () => {
  const record = locallyTested({ implementer_session: session('same'), validator_session: session('same') })
  assertProblem(recordProblems(record), 'validator_session.id')
})

test('R8 a re-execution uses a different model and a fresh session id', () => {
  const sameModel = locallyTested({ reexecuted_by: session('reexec-1', 'claude-sonnet-5') })
  assertProblem(recordProblems(sameModel), 'reexecuted_by.model')
  const ok = locallyTested({ reexecuted_by: session('reexec-1', 'gpt-5') })
  assert.deepEqual(recordProblems(ok), [])
})

test('R9 PASS requires exit_code 0 and FAIL requires a non-zero exit_code', () => {
  assertProblem(recordProblems(locallyTested({ result: 'PASS', exit_code: 1 })), 'exit_code')
  assertProblem(recordProblems(locallyTested({ result: 'FAIL', exit_code: 0 })), 'exit_code')
})

test('R10 a BLOCKED kit status needs a complete, valid wired', () => {
  assertProblem(recordProblems(locallyTested({ kit_refs: { 'M2-REL-01': 'BLOCKED' } })), 'counts as NOT_MET')

  const wired = {
    client: 'src/main/x.ts',
    contract_fake: 'src/main/x.test.ts',
    probe: 'node scripts/x.mjs',
    capability: 'x-capability',
    unblock_step: 'ask the owner to enable X'
  }
  assert.deepEqual(recordProblems(locallyTested({ kit_refs: { 'M2-REL-01': 'BLOCKED' }, wired })), [])

  assertProblem(
    recordProblems(locallyTested({ kit_refs: { 'M2-REL-01': 'BLOCKED' }, wired: { ...wired, contract_fake: 'src/main/x.ts' } })),
    'wired.contract_fake'
  )
  assertProblem(
    recordProblems(locallyTested({ kit_refs: { 'M2-REL-01': 'BLOCKED' }, wired: { ...wired, client: 'src/main/x.test.ts' } })),
    'wired.client'
  )
  assertProblem(
    recordProblems(locallyTested({ kit_refs: { 'M2-REL-01': 'BLOCKED' }, wired: { ...wired, probe: 'a && b' } })),
    'wired.probe'
  )
})

test('R11 a user home path or an email address is rejected anywhere in the record', () => {
  assertProblem(recordProblems(locallyTested({ command: 'cat /home/example/notes.txt' })), 'command', 'user home path')
  const withEmail = accepted({ owner_statement: { date: '2026-09-26', text: 'Approved by someone@example.com' } })
  assertProblem(recordProblems(withEmail), 'owner_statement.text', 'email')
})

test('R12 output.path rejects a parent-relative, absolute or backslash path', () => {
  for (const bad of ['../x', '/abs', 'a\\b']) {
    assertProblem(recordProblems(hostConfigured({ output: { path: bad, sha256: SHA256_A } })), 'output.path')
  }
})

test('R13 repro.commit must differ from commit, and repro.test must be a test path', () => {
  assertProblem(
    recordProblems(locallyTested({ repro: { test: 'src/main/x.test.ts', commit: SHA1_A, ci_run_id: 99 } })),
    'repro.commit'
  )
  assertProblem(
    recordProblems(locallyTested({ repro: { test: 'src/main/x.ts', commit: SHA1_B, ci_run_id: 99 } })),
    'repro.test'
  )
})

test('R14 DESIGNED requires output or pr; either alone is enough', () => {
  assertProblem(recordProblems(base({ evidence_level: 'DESIGNED' })), 'DESIGNED requires output or pr')
  assert.deepEqual(recordProblems(base({ evidence_level: 'DESIGNED', pr: 1 })), [])
  assert.deepEqual(
    recordProblems(base({ evidence_level: 'DESIGNED', output: { path: 'evidence/x.json', sha256: SHA256_A } })),
    []
  )
})

test('R15 an optional field set to null counts as absent', () => {
  assert.deepEqual(recordProblems(locallyTested({ artifact_sha256: null })), [])
})

test('R16 parseRecordLines: line numbers, bad JSON, CRLF, blank line', () => {
  const line1 = JSON.stringify(designed())
  const line2 = JSON.stringify(locallyTested())

  const ok = parseRecordLines(`${line1}\n${line2}\n`)
  assert.equal(ok.records.length, 2)
  assert.equal(ok.records[0].line, 1)
  assert.equal(ok.records[1].line, 2)
  assert.deepEqual(ok.problems, [])

  const bad = parseRecordLines(`${line1}\nnot json\n${line2}\n`)
  assert.equal(bad.records.length, 2)
  assertProblem(bad.problems, '2:', 'invalid JSON')

  const crlf = parseRecordLines(`${line1}\r\n${line2}\r\n`)
  assert.equal(crlf.records.length, 2)
  assert.deepEqual(crlf.problems, [])

  const blank = parseRecordLines(`${line1}\n\n${line2}\n`)
  assertProblem(blank.problems, '2:', 'blank line')
})

test('R17 recordsInPrBody extracts fenced evidence blocks only, ignoring plain json blocks and HTML comments', () => {
  const record = locallyTested()
  const body = [
    'intro text',
    '```json evidence',
    JSON.stringify(record),
    '```',
    '```json',
    '{"not":"evidence"}',
    '```',
    '<!--',
    '```json evidence',
    '{"ignored": true}',
    '```',
    '-->'
  ].join('\n')
  const { records, problems } = recordsInPrBody(body)
  assert.equal(records.length, 1)
  assert.deepEqual(records[0], record)
  assert.deepEqual(problems, [])

  assertProblem(recordsInPrBody('```json evidence\nnot json\n```').problems, 'invalid JSON')
})

test('R18 latestByLevel returns the last record per level in array order', () => {
  const first = locallyTested({ result: 'FAIL', exit_code: 1 })
  const second = locallyTested({ result: 'PASS', exit_code: 0, ci_run_id: 202 })
  assert.equal(latestByLevel([first, second]).get('LOCALLY_TESTED'), second)
})

test('R19 readRecordStore: missing dir, .gitkeep, unexpected file, ticket/stem mismatch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-store-'))
  assert.deepEqual(readRecordStore(join(dir, 'missing')), { recordsByTicket: new Map(), problems: [] })

  writeFileSync(join(dir, '.gitkeep'), '')
  writeFileSync(join(dir, 'notes.txt'), 'hello')
  writeFileSync(join(dir, 'M2-0002.jsonl'), `${JSON.stringify(locallyTested())}\n`)
  writeFileSync(join(dir, 'M2-0003.jsonl'), `${JSON.stringify(locallyTested({ ticket: 'M2-0002' }))}\n`)

  // A line in a correctly-named file that fails recordProblems is reported and excluded; the file's
  // other valid lines still count.
  writeFileSync(
    join(dir, 'M2-0004.jsonl'),
    `${JSON.stringify(locallyTested({ ticket: 'M2-0004', result: 'MAYBE' }))}\n${JSON.stringify(locallyTested({ ticket: 'M2-0004', ci_run_id: 303 }))}\n`
  )

  const { recordsByTicket, problems } = readRecordStore(dir)
  assert.deepEqual(recordsByTicket.get('M2-0002'), [locallyTested()])
  assert.equal(recordsByTicket.has('M2-0003'), false)
  assert.deepEqual(recordsByTicket.get('M2-0004'), [locallyTested({ ticket: 'M2-0004', ci_run_id: 303 })])
  assertProblem(problems, 'notes.txt', 'unexpected file name')
  assertProblem(problems, 'M2-0003.jsonl', 'does not match file')
  assertProblem(problems, 'M2-0004.jsonl:1', 'result: expected PASS or FAIL')
})
