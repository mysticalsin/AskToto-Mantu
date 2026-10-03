import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RECORD_SCHEMA } from './record.mjs'
import { closedSince, drawSample, populationOf } from './sample.mjs'

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
    commit: '1'.repeat(40), result: 'PASS', implementer_session: session('impl-1'),
    validator_session: session('valid-1'), pr: 1, ci_run_id: 1,
    environment: { kind: 'ci', host: 'ubuntu-latest' }, command: 'npm test', exit_code: 0,
    ...overrides
  }
}

test('S1 population holds DONE/ENGINEERING_COMPLETE tickets closed at or after since, and excludes the rest', () => {
  const since = '2026-09-15'
  const tickets = [
    ticket({ id: 'M2-0001', status: 'DONE' }),
    ticket({ id: 'M2-0002', status: 'ENGINEERING_COMPLETE' }),
    ticket({ id: 'M2-0003', status: 'TODO' }),
    ticket({ id: 'M2-0004', status: 'IN_PROGRESS' }),
    ticket({ id: 'M2-0005', status: 'DEFERRED' }),
    ticket({ id: 'M2-0006', status: 'CANCELLED' }),
    ticket({ id: 'M2-0007', status: 'DONE' }) // closed before `since`
  ]
  const recordsByTicket = new Map([
    ['M2-0001', [record({ ticket: 'M2-0001', recorded_at: '2026-09-20T00:00:00Z' })]],
    ['M2-0002', [record({ ticket: 'M2-0002', recorded_at: '2026-09-16T00:00:00Z' })]],
    ['M2-0003', [record({ ticket: 'M2-0003', recorded_at: '2026-09-20T00:00:00Z' })]],
    ['M2-0004', [record({ ticket: 'M2-0004', recorded_at: '2026-09-20T00:00:00Z' })]],
    ['M2-0005', [record({ ticket: 'M2-0005', recorded_at: '2026-09-20T00:00:00Z' })]],
    ['M2-0006', [record({ ticket: 'M2-0006', recorded_at: '2026-09-20T00:00:00Z' })]],
    ['M2-0007', [record({ ticket: 'M2-0007', recorded_at: '2026-09-10T00:00:00Z' })]]
  ])
  assert.deepEqual(closedSince({ tickets }, recordsByTicket, since).sort(), ['M2-0001', 'M2-0002'])
})

test('S2 size: 0 of 0, 1 of 1, 1 of 10, 2 of 11, 3 of 30', () => {
  const idsOfLength = (n) => Array.from({ length: n }, (_, i) => `M2-${String(i).padStart(4, '0')}`)
  assert.equal(drawSample(idsOfLength(0), 'seed').length, 0)
  assert.equal(drawSample(idsOfLength(1), 'seed').length, 1)
  assert.equal(drawSample(idsOfLength(10), 'seed').length, 1)
  assert.equal(drawSample(idsOfLength(11), 'seed').length, 2)
  assert.equal(drawSample(idsOfLength(30), 'seed').length, 3)
})

test('S3 the draw is a pure function of the population and the seed, independent of input order', () => {
  const ids = Array.from({ length: 30 }, (_, i) => `M2-${String(i).padStart(4, '0')}`)
  const sampleA = drawSample(ids, 'gate-sha-1')
  const sampleB = drawSample([...ids].reverse(), 'gate-sha-1')
  assert.deepEqual(sampleA, sampleB)
  assert.notDeepEqual(sampleA, drawSample(ids, 'gate-sha-2'))
})

test('S4 CLI prints population and sample and exits 0; a missing --seed or an unreadable ledger exits 2', () => {
  const root = mkdtempSync(join(tmpdir(), 'evidence-sample-'))
  mkdirSync(join(root, 'ledger'), { recursive: true })
  mkdirSync(join(root, 'evidence', 'records'), { recursive: true })
  const ledgerPath = join(root, 'ledger', 'tickets.json')
  writeFileSync(ledgerPath, JSON.stringify({ tickets: [ticket({ id: 'M2-0001', status: 'DONE' })] }))
  writeFileSync(
    join(root, 'evidence', 'records', 'M2-0001.jsonl'),
    `${JSON.stringify(record({ ticket: 'M2-0001', recorded_at: '2026-09-20T00:00:00Z' }))}\n`
  )

  const cliPath = fileURLToPath(new URL('./sample.mjs', import.meta.url))
  const output = execFileSync(
    process.execPath,
    [cliPath, '--ledger', ledgerPath, '--since', '2026-09-01', '--seed', 'gate-sha'],
    { encoding: 'utf8' }
  )
  const parsed = JSON.parse(output)
  assert.deepEqual(parsed.population, ['M2-0001'])
  assert.deepEqual(parsed.sample, ['M2-0001'])

  assert.throws(
    () => execFileSync(process.execPath, [cliPath, '--ledger', ledgerPath, '--since', '2026-09-01'], { encoding: 'utf8', stdio: 'pipe' }),
    { status: 2 }
  )

  assert.throws(
    () => execFileSync(
      process.execPath,
      [cliPath, '--ledger', join(root, 'ledger', 'missing.json'), '--since', '2026-09-01', '--seed', 'gate-sha'],
      { encoding: 'utf8', stdio: 'pipe' }
    ),
    { status: 2 }
  )
})

test('S5 --population-of takes the ticket dependencies that are closed by status, ignoring recorded_at, and draws reproducibly', () => {
  const root = mkdtempSync(join(tmpdir(), 'evidence-sample-of-'))
  mkdirSync(join(root, 'ledger'), { recursive: true })
  mkdirSync(join(root, 'evidence', 'records'), { recursive: true })
  const ledgerPath = join(root, 'ledger', 'tickets.json')
  const tickets = [
    ticket({ id: 'M2-0001', status: 'DONE' }),
    ticket({ id: 'M2-0002', status: 'ENGINEERING_COMPLETE' }),
    ticket({ id: 'M2-0003', status: 'TODO' }),
    ticket({ id: 'M2-0004', status: 'CANCELLED' }),
    ticket({ id: 'M2-0005', status: 'DONE' }), // closed but not a dependency
    ticket({ id: 'M2-0046', status: 'TODO', depends_on: ['M2-0001', 'M2-0002', 'M2-0003', 'M2-0004'] })
  ]
  writeFileSync(ledgerPath, JSON.stringify({ tickets }))
  // M2-0001's only record is old: --since would drop it, --population-of must not.
  writeFileSync(
    join(root, 'evidence', 'records', 'M2-0001.jsonl'),
    `${JSON.stringify(record({ ticket: 'M2-0001', recorded_at: '2020-01-01T00:00:00Z' }))}\n`
  )

  assert.deepEqual(populationOf({ tickets }, 'M2-0046'), ['M2-0001', 'M2-0002'])
  assert.equal(populationOf({ tickets }, 'M2-9999'), null)

  const cliPath = fileURLToPath(new URL('./sample.mjs', import.meta.url))
  const seed = 'a'.repeat(40)
  const run = () => JSON.parse(execFileSync(
    process.execPath,
    [cliPath, '--ledger', ledgerPath, '--population-of', 'M2-0046', '--seed', seed],
    { encoding: 'utf8' }
  ))
  const first = run()
  assert.deepEqual(first.population, ['M2-0001', 'M2-0002'])
  assert.equal(first.populationRule, 'depends-on-closed')
  assert.equal(first.of, 'M2-0046')
  assert.deepEqual(first.sample, drawSample(['M2-0001', 'M2-0002'], seed))
  assert.deepEqual(run(), first)
})

test('S6 --population-of usage errors exit 2: both selectors, neither, and an unknown ticket', () => {
  const root = mkdtempSync(join(tmpdir(), 'evidence-sample-usage-'))
  mkdirSync(join(root, 'ledger'), { recursive: true })
  const ledgerPath = join(root, 'ledger', 'tickets.json')
  writeFileSync(ledgerPath, JSON.stringify({ tickets: [ticket({ id: 'M2-0001', status: 'DONE' })] }))
  const cliPath = fileURLToPath(new URL('./sample.mjs', import.meta.url))
  const exits = (...args) => assert.throws(
    () => execFileSync(process.execPath, [cliPath, '--ledger', ledgerPath, '--seed', 'gate-sha', ...args], { encoding: 'utf8', stdio: 'pipe' }),
    { status: 2 }
  )
  exits('--population-of', 'M2-0001', '--since', '2026-09-01')
  exits()
  exits('--population-of', 'M2-9999')
})
