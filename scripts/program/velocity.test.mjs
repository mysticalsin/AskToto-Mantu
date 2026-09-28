import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeProgram, DEFAULT_DEGRADE_ORDER, renderForecastMarkdown, runCli } from './velocity.mjs'

const SHA1_A = '1'.repeat(40)
const SHA1_B = '2'.repeat(40)

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'metis-velocity-'))
}

function record(ticket, evidenceLevel, recordedAt, overrides = {}) {
  return {
    schema: 1,
    ticket,
    evidence_level: evidenceLevel,
    recorded_at: recordedAt,
    kit_refs: {},
    finding_refs: [],
    commit: SHA1_A,
    result: 'PASS',
    implementer_session: { model: 'claude-sonnet-5', id: `impl-${ticket}-${evidenceLevel}` },
    validator_session: { model: 'claude-sonnet-5', id: `valid-${ticket}-${evidenceLevel}` },
    environment: { kind: 'ci', host: 'ubuntu-latest' },
    command: 'node --test scripts/program/velocity.test.mjs',
    exit_code: 0,
    ...overrides
  }
}

function writeRecords(dir, recordsByTicket) {
  const recordsDir = join(dir, 'evidence', 'records')
  mkdirSync(recordsDir, { recursive: true })
  for (const [ticket, records] of Object.entries(recordsByTicket)) {
    writeFileSync(join(recordsDir, `${ticket}.jsonl`), `${records.map((entry) => JSON.stringify(entry)).join('\n')}\n`)
  }
  return recordsDir
}

function ticket(id, overrides = {}) {
  return {
    id,
    title: id,
    wave: 'W0',
    milestone: 'm3',
    type: 'process',
    status: 'TODO',
    depends_on: [],
    needs_decision: [],
    kit_refs: [],
    finding_refs: [],
    estimate_hours: 4,
    required_evidence: ['LOCALLY_TESTED'],
    external_blocker: null,
    flag: null,
    slices: [],
    ...overrides
  }
}

test('analyzeProgram counts estimated hours on the date all required evidence is satisfied', () => {
  const ledger = {
    decisions: { 'D-14': 'ANSWERED_AS_DEFAULT' },
    tickets: [
      ticket('M2-0001', { status: 'DONE', estimate_hours: 5, milestone: 'm3' }),
      ticket('M2-0002', {
        status: 'DONE',
        estimate_hours: 8,
        milestone: 'm3',
        required_evidence: ['LOCALLY_TESTED', 'ACCEPTED']
      }),
      ticket('M2-0003', { status: 'IN_PROGRESS', estimate_hours: 13, milestone: 'm5' })
    ]
  }
  const recordsByTicket = new Map([
    ['M2-0001', [record('M2-0001', 'LOCALLY_TESTED', '2026-09-20T10:00:00Z')]],
    ['M2-0002', [
      record('M2-0002', 'LOCALLY_TESTED', '2026-09-21T10:00:00Z'),
      record('M2-0002', 'ACCEPTED', '2026-09-22T10:00:00Z', {
        environment: undefined,
        command: undefined,
        exit_code: undefined,
        owner_statement: { date: '2026-09-22', text: 'Owner accepted the evidence.' }
      })
    ]]
  ])

  const forecast = analyzeProgram({ ledger, recordsByTicket, asOf: '2026-09-24' })

  assert.equal(forecast.totalEstimatedHours, 26)
  assert.equal(forecast.closedEstimatedHours, 13)
  assert.deepEqual(forecast.closedHoursPerDay, [
    { date: '2026-09-20', estimated_hours: 5, tickets: ['M2-0001'] },
    { date: '2026-09-22', estimated_hours: 8, tickets: ['M2-0002'] }
  ])
  assert.equal(forecast.velocityHoursPerDay, 2.6)
  assert.deepEqual(forecast.remainingHoursByMilestone, [
    { milestone: 'm5', estimated_hours: 13, tickets: ['M2-0003'] }
  ])
})

test('analyzeProgram does not count a closed ticket when the latest required evidence is not passing', () => {
  const ledger = {
    decisions: { 'D-14': 'ANSWERED_AS_DEFAULT' },
    tickets: [ticket('M2-0001', { status: 'DONE', estimate_hours: 5 })]
  }
  const recordsByTicket = new Map([
    ['M2-0001', [
      record('M2-0001', 'LOCALLY_TESTED', '2026-09-20T10:00:00Z'),
      record('M2-0001', 'LOCALLY_TESTED', '2026-09-21T10:00:00Z', {
        commit: SHA1_B,
        result: 'FAIL',
        exit_code: 1
      })
    ]]
  ])

  const forecast = analyzeProgram({ ledger, recordsByTicket, asOf: '2026-09-24' })

  assert.equal(forecast.closedEstimatedHours, 0)
  assert.deepEqual(forecast.closedHoursPerDay, [])
  assert.deepEqual(forecast.remainingHoursByMilestone, [
    { milestone: 'm3', estimated_hours: 5, tickets: ['M2-0001'] }
  ])
})

test('analyzeProgram records D-14 degrade order and flags an unapproved decision', () => {
  const ledger = {
    decisions: { 'D-14': 'OPEN' },
    tickets: [ticket('M2-0197', { status: 'IN_PROGRESS', needs_decision: ['D-14'] })]
  }

  const forecast = analyzeProgram({ ledger, recordsByTicket: new Map(), asOf: '2026-09-24' })

  assert.deepEqual(forecast.degradeOrder.map((entry) => entry.ticket), DEFAULT_DEGRADE_ORDER)
  assert.equal(forecast.decision.id, 'D-14')
  assert.equal(forecast.decision.ownerApproved, false)
  assert.ok(forecast.problems.some((problem) => problem.includes('D-14')))
})

test('analyzeProgram does not approve ANSWERED_CHANGED without an explicit owner-approved changed order', () => {
  const ledger = {
    decisions: { 'D-14': 'ANSWERED_CHANGED' },
    tickets: [ticket('M2-0197', { status: 'IN_PROGRESS', needs_decision: ['D-14'] })]
  }

  const forecast = analyzeProgram({ ledger, recordsByTicket: new Map(), asOf: '2026-09-24' })

  assert.equal(forecast.decision.status, 'ANSWERED_CHANGED')
  assert.equal(forecast.decision.ownerApproved, false)
  assert.deepEqual(forecast.degradeOrder, [])
  assert.ok(forecast.problems.some((problem) => problem.includes('ANSWERED_CHANGED')))
})

test('analyzeProgram renders an explicitly owner-approved changed D-14 degrade order', () => {
  const changedOrder = ['M2-0156', 'M2-0161']
  const ledger = {
    decisions: { 'D-14': 'ANSWERED_CHANGED' },
    degrade_orders: {
      'D-14': { owner_approved: true, order: changedOrder }
    },
    tickets: [ticket('M2-0197', { status: 'IN_PROGRESS', needs_decision: ['D-14'] })]
  }

  const forecast = analyzeProgram({ ledger, recordsByTicket: new Map(), asOf: '2026-09-24' })

  assert.equal(forecast.decision.ownerApproved, true)
  assert.deepEqual(forecast.degradeOrder.map((entry) => entry.ticket), changedOrder)
  assert.deepEqual(forecast.problems, [])
})

test('renderForecastMarkdown names the gate forecast, remaining milestone hours, and degrade invariant', () => {
  const forecast = analyzeProgram({
    ledger: {
      decisions: { 'D-14': 'ANSWERED_AS_DEFAULT' },
      tickets: [ticket('M2-0001', { status: 'DONE', estimate_hours: 5 })]
    },
    recordsByTicket: new Map([['M2-0001', [record('M2-0001', 'LOCALLY_TESTED', '2026-09-20T10:00:00Z')]]]),
    asOf: '2026-09-24',
    gate: 'm3'
  })

  const markdown = renderForecastMarkdown(forecast)

  assert.match(markdown, /^# Delivery Velocity Forecast/m)
  assert.match(markdown, /\*\*Gate:\*\* m3/)
  assert.match(markdown, /closed with evidence/)
  assert.match(markdown, /D-14/)
  assert.match(markdown, /lowers evidence level or ships DEFERRED flag-off/)
  assert.match(markdown, /M2-0155/)
})

test('runCli writes forecast artifacts to the requested output directory', () => {
  const dir = tempDir()
  try {
    const ledgerDir = join(dir, 'ledger')
    const outDir = join(dir, 'out')
    mkdirSync(ledgerDir, { recursive: true })
    const ledgerPath = join(ledgerDir, 'tickets.json')
    writeFileSync(ledgerPath, JSON.stringify({
      decisions: { 'D-14': 'ANSWERED_AS_DEFAULT' },
      tickets: [ticket('M2-0001', { status: 'DONE', estimate_hours: 5 })]
    }))
    const recordsDir = writeRecords(dir, {
      'M2-0001': [record('M2-0001', 'LOCALLY_TESTED', '2026-09-20T10:00:00Z')]
    })

    const code = runCli(['--ledger', ledgerPath, '--records', recordsDir, '--out-dir', outDir, '--as-of', '2026-09-24'])

    assert.equal(code, 0)
    assert.ok(existsSync(join(outDir, 'FORECAST.md')))
    assert.ok(existsSync(join(outDir, 'forecast.json')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
