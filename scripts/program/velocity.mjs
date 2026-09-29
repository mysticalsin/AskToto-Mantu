import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { latestByLevel, readRecordStore } from '../evidence/record.mjs'

const CLOSED_STATUSES = new Set(['DONE', 'ENGINEERING_COMPLETE', 'DEFERRED'])
const DECISION_ID = 'D-14'
const TICKET_ID_RE = /^M2-\d{4}$/
const IN_HOUSE_EVIDENCE = new Set(['DESIGNED', 'LOCALLY_TESTED'])

export const DEFAULT_DEGRADE_ORDER = Object.freeze(['M2-0155', 'M2-0124', 'M2-0185', 'M2-0161', 'M2-0156'])

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function dayOf(instant) {
  return instant.slice(0, 10)
}

function daysInclusive(startDate, endDate) {
  const start = Date.parse(`${startDate}T00:00:00Z`)
  const end = Date.parse(`${endDate}T00:00:00Z`)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0
  return Math.floor((end - start) / 86_400_000) + 1
}

function ticketHours(ticket) {
  return typeof ticket.estimate_hours === 'number' && Number.isFinite(ticket.estimate_hours) ? ticket.estimate_hours : 0
}

function milestoneOf(ticket) {
  return typeof ticket.milestone === 'string' && ticket.milestone.length > 0 ? ticket.milestone : 'unassigned'
}

function requiredLevels(ticket) {
  return Array.isArray(ticket.required_evidence) ? ticket.required_evidence : []
}

function latestPassingRecords(latest, levels) {
  const passing = []
  for (const level of levels) {
    const record = latest.get(level)
    if (!record || record.result !== 'PASS' || typeof record.recorded_at !== 'string') return null
    passing.push(record)
  }
  return passing
}

function capsOf(id, byId) {
  const caps = []
  const visited = new Set([id])
  const stack = [...(byId.get(id)?.depends_on ?? [])]
  while (stack.length > 0) {
    const depId = stack.pop()
    if (visited.has(depId)) continue
    visited.add(depId)
    const dep = byId.get(depId)
    if (!dep) continue
    if (dep.status === 'ENGINEERING_COMPLETE' || dep.status === 'BLOCKED_EXTERNAL') caps.push(dep)
    stack.push(...(dep.depends_on ?? []))
  }
  return caps
}

const rootsOf = (caps) => caps.filter((dep) => dep.external_blocker != null)

// Mirrors check.mjs's inheritedBlockProblems: a closure the ledger checker would reject for missing
// inherited_block must not count as delivered velocity either.
function listsInheritedBlock(latest, roots) {
  if (roots.length === 0) return true
  for (const record of latest.values()) {
    const listed = new Set((record.inherited_block ?? []).map((entry) => entry.ticket))
    for (const root of roots) {
      if (!listed.has(root.id)) return false
    }
  }
  return true
}

function closedEvidence(ticket, records, caps = []) {
  if (!CLOSED_STATUSES.has(ticket.status)) return null
  const latest = latestByLevel(records)
  const required = requiredLevels(ticket)
  if (required.length === 0) return null

  let passing
  if (ticket.status === 'ENGINEERING_COMPLETE') {
    if (!(ticket.external_blocker != null || caps.length > 0)) return null
    if (!listsInheritedBlock(latest, rootsOf(caps))) return null
    const inHouseRequired = required.filter((level) => IN_HOUSE_EVIDENCE.has(level))
    passing = latestPassingRecords(latest, inHouseRequired)
    if (!passing) return null
    const anyLatestPass = [...latest.values()].find((record) => record.result === 'PASS' && typeof record.recorded_at === 'string')
    if (!anyLatestPass) return null
    if (passing.length === 0) passing = [anyLatestPass]
  } else {
    passing = latestPassingRecords(latest, required)
    if (!passing) return null
  }

  const closedAt = passing
    .map((record) => record.recorded_at)
    .sort()
    .at(-1)
  return { closedAt, closedDate: dayOf(closedAt), records: passing }
}

function decisionEntry(ledger) {
  const raw = isPlainObject(ledger?.decisions) ? ledger.decisions[DECISION_ID] : undefined
  const status = isPlainObject(raw) ? raw.status : raw
  const changedOrder = changedDegradeOrder(ledger, raw)
  const ownerApproved = raw === true ||
    status === 'ANSWERED_AS_DEFAULT' ||
    status === 'APPROVED' ||
    (status === 'ANSWERED_CHANGED' && changedOrder.ownerApproved && changedOrder.order.length > 0) ||
    (isPlainObject(raw) && raw.owner_approved === true && status !== 'ANSWERED_CHANGED')
  return {
    id: DECISION_ID,
    status: status ?? 'UNKNOWN',
    ownerApproved,
    // An OPEN decision proceeds on its recorded default order, labelled ASSUMED until the owner answers.
    assumed: !ownerApproved && status === 'OPEN',
    changedOrder,
    source: raw === undefined ? 'missing' : 'ledger'
  }
}

function normalizeOrder(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const order = []
  for (const item of value) {
    if (typeof item !== 'string' || !TICKET_ID_RE.test(item) || seen.has(item)) return []
    seen.add(item)
    order.push(item)
  }
  return order
}

function orderFromEntry(entry) {
  if (Array.isArray(entry)) return normalizeOrder(entry)
  if (!isPlainObject(entry)) return []
  return normalizeOrder(entry.order ?? entry.degrade_order ?? entry.tickets)
}

function changedDegradeOrder(ledger, decisionRaw) {
  const entry = isPlainObject(ledger?.degrade_orders) ? ledger.degrade_orders[DECISION_ID] : undefined
  const entryOrder = orderFromEntry(entry)
  const decisionOrder = orderFromEntry(decisionRaw)
  const order = entryOrder.length > 0 ? entryOrder : decisionOrder
  const ownerApproved = (isPlainObject(entry) && entry.owner_approved === true) ||
    (isPlainObject(decisionRaw) && decisionRaw.owner_approved === true)
  return {
    ownerApproved,
    order,
    source: entry === undefined ? (order.length > 0 ? 'decisions' : 'missing') : 'degrade_orders'
  }
}

function summarizeDegradeOrder(order = DEFAULT_DEGRADE_ORDER) {
  return order.map((ticket, index) => ({
    rank: index + 1,
    ticket,
    action: 'Lower evidence level or ship DEFERRED flag-off; keep every traced ID in the ledger.'
  }))
}

function round2(value) {
  return Math.round(value * 100) / 100
}

function pushHours(map, key, ticket) {
  const existing = map.get(key) ?? { estimated_hours: 0, tickets: [] }
  existing.estimated_hours += ticketHours(ticket)
  existing.tickets.push(ticket.id)
  map.set(key, existing)
}

export function analyzeProgram({ ledger, recordsByTicket, asOf, gate = 'm3' }) {
  const tickets = Array.isArray(ledger?.tickets) ? ledger.tickets : []
  const ticketsById = new Map(tickets
    .filter((ticket) => isPlainObject(ticket) && typeof ticket.id === 'string')
    .map((ticket) => [ticket.id, ticket]))
  const analysisDate = asOf ?? new Date().toISOString().slice(0, 10)
  const closedByDay = new Map()
  const remainingByMilestone = new Map()
  const problems = []
  let closedEstimatedHours = 0

  for (const ticket of tickets) {
    if (!isPlainObject(ticket) || typeof ticket.id !== 'string') continue
    const evidence = closedEvidence(ticket, recordsByTicket.get(ticket.id) ?? [], capsOf(ticket.id, ticketsById))
    if (evidence) {
      closedEstimatedHours += ticketHours(ticket)
      pushHours(closedByDay, evidence.closedDate, ticket)
    } else if (ticket.status !== 'CANCELLED') {
      pushHours(remainingByMilestone, milestoneOf(ticket), ticket)
    }
  }

  const closedHoursPerDay = [...closedByDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, value]) => ({ date, estimated_hours: value.estimated_hours, tickets: value.tickets.sort() }))
  const remainingHoursByMilestone = [...remainingByMilestone.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([milestone, value]) => ({ milestone, estimated_hours: value.estimated_hours, tickets: value.tickets.sort() }))
  const firstClosedDate = closedHoursPerDay[0]?.date ?? null
  const measuredDays = firstClosedDate ? daysInclusive(firstClosedDate, analysisDate) : 0
  const velocityHoursPerDay = measuredDays > 0 ? round2(closedEstimatedHours / measuredDays) : 0
  const totalRemainingHours = remainingHoursByMilestone.reduce((sum, row) => sum + row.estimated_hours, 0)
  const forecastCompletionDate = velocityHoursPerDay > 0
    ? new Date(Date.parse(`${analysisDate}T00:00:00Z`) + Math.ceil(totalRemainingHours / velocityHoursPerDay) * 86_400_000).toISOString().slice(0, 10)
    : null
  const decision = decisionEntry(ledger)
  if (!decision.ownerApproved && !decision.assumed) {
    problems.push(`${DECISION_ID}: owner-approved degrade order is not recorded as approved in the ledger`)
  }
  if (decision.status === 'ANSWERED_CHANGED' && decision.changedOrder.order.length === 0) {
    problems.push(`${DECISION_ID}: ANSWERED_CHANGED requires an explicit changed degrade order in ledger.degrade_orders.${DECISION_ID}`)
  } else if (decision.status === 'ANSWERED_CHANGED' && !decision.changedOrder.ownerApproved) {
    problems.push(`${DECISION_ID}: changed degrade order is present but not owner-approved`)
  }
  const degradeOrder = decision.status === 'ANSWERED_CHANGED'
    ? summarizeDegradeOrder(decision.changedOrder.order)
    : summarizeDegradeOrder()

  return {
    gate,
    asOf: analysisDate,
    totalTickets: tickets.length,
    totalEstimatedHours: tickets.reduce((sum, ticket) => sum + ticketHours(ticket), 0),
    closedEstimatedHours,
    measuredDays,
    velocityHoursPerDay,
    totalRemainingHours,
    forecastCompletionDate,
    closedHoursPerDay,
    remainingHoursByMilestone,
    decision,
    degradeOrder,
    problems
  }
}

function table(headers, rows) {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`)
  ].join('\n')
}

export function renderForecastMarkdown(forecast) {
  const closedRows = forecast.closedHoursPerDay.length > 0
    ? forecast.closedHoursPerDay.map((row) => [row.date, String(row.estimated_hours), row.tickets.join(', ')])
    : [['none', '0', '']]
  const remainingRows = forecast.remainingHoursByMilestone.length > 0
    ? forecast.remainingHoursByMilestone.map((row) => [row.milestone, String(row.estimated_hours), row.tickets.join(', ')])
    : [['none', '0', '']]
  const degradeRows = forecast.degradeOrder.map((row) => [String(row.rank), row.ticket, row.action])
  const allProblems = [...(forecast.recordStoreProblems ?? []), ...forecast.problems]
  const problems = allProblems.length > 0
    ? allProblems.map((problem) => `- ${problem}`).join('\n')
    : '- none'

  return `# Delivery Velocity Forecast

**Gate:** ${forecast.gate}
**As of:** ${forecast.asOf}
**Tickets measured:** ${forecast.totalTickets}
**Estimated hours:** ${forecast.totalEstimatedHours}
**Closed with evidence:** ${forecast.closedEstimatedHours}
**Measured velocity:** ${forecast.velocityHoursPerDay} estimated hours/day over ${forecast.measuredDays} day(s)
**Remaining estimated hours:** ${forecast.totalRemainingHours}
**Forecast completion date:** ${forecast.forecastCompletionDate ?? 'UNKNOWN'}

## Closed Hours Per Day

${table(['Date', 'Estimated hours', 'Tickets'], closedRows)}

## Remaining Hours By Milestone

${table(['Milestone', 'Estimated hours', 'Tickets'], remainingRows)}

## D-14 Degrade Order

**Decision status:** ${forecast.decision.status}
**Owner approved:** ${forecast.decision.ownerApproved ? 'yes' : forecast.decision.assumed ? 'no (ASSUMED: default order while OPEN)' : 'no'}

${table(['Rank', 'Ticket', 'Invariant'], degradeRows)}

Degrading lowers evidence level or ships DEFERRED flag-off; every traced ID remains in the ledger.

## Problems

${problems}
`
}

function defaultRecordsDir(ledgerPath) {
  return join(resolve(dirname(ledgerPath), '..'), 'evidence', 'records')
}

function usage(message) {
  console.error(message)
  console.error('usage: velocity.mjs --ledger <path> [--records <dir>] [--out-dir <dir>] [--gate <id>] [--as-of YYYY-MM-DD]')
  return 2
}

function readLedger(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeArtifacts(outDir, forecast) {
  mkdirSync(outDir, { recursive: true })
  const jsonPath = join(outDir, 'forecast.json')
  const markdownPath = join(outDir, 'FORECAST.md')
  writeFileSync(jsonPath, `${JSON.stringify(forecast, null, 2)}\n`)
  writeFileSync(markdownPath, renderForecastMarkdown(forecast))
  return { jsonPath, markdownPath }
}

export function runCli(argv = process.argv.slice(2)) {
  let values
  try {
    ;({ values } = parseArgs({
      args: argv,
      options: {
        ledger: { type: 'string' },
        records: { type: 'string' },
        'out-dir': { type: 'string', default: join('out', 'program-velocity') },
        gate: { type: 'string', default: 'm3' },
        'as-of': { type: 'string' }
      }
    }))
  } catch (error) {
    return usage(error.message)
  }

  if (typeof values.ledger !== 'string') return usage('--ledger is required')
  if (values['as-of'] && !/^\d{4}-\d{2}-\d{2}$/.test(values['as-of'])) return usage('--as-of must be YYYY-MM-DD')

  const ledgerPath = resolve(values.ledger)
  if (!existsSync(ledgerPath)) return usage(`ledger does not exist: ${values.ledger}`)

  const recordsDir = resolve(values.records ?? defaultRecordsDir(ledgerPath))
  const { recordsByTicket, problems: recordProblems } = readRecordStore(recordsDir)
  const forecast = analyzeProgram({
    ledger: readLedger(ledgerPath),
    recordsByTicket,
    asOf: values['as-of'],
    gate: values.gate
  })
  forecast.recordStoreProblems = recordProblems
  const artifacts = writeArtifacts(resolve(values['out-dir']), forecast)

  for (const problem of [...recordProblems, ...forecast.problems]) console.error(`- ${problem}`)
  console.log(`velocity: wrote ${artifacts.markdownPath}`)
  return recordProblems.length === 0 && forecast.problems.length === 0 ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCli()
}
