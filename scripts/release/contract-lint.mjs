// Release contract linter (M2-0171). Ten checks that turn "is this commit releasable" from an assertion
// into a computation over the evidence registry (ledger + per-ticket receipt records) and the
// traceability matrix. Pure: every input is passed in, so decide.mjs owns all file and git access and
// the tests need neither. Under D-28 it runs only in GitHub Actions.
//
// Matrix shape: { rows: [{ id: string, tickets: string[] }] } - each requirement row names the tickets
// that deliver it.
import { IN_HOUSE, TICKET_STATUSES, ledgerProblems } from '../evidence/check.mjs'
import { latestByLevel } from '../evidence/record.mjs'

const CLOSED = new Set(['DONE', 'ENGINEERING_COMPLETE'])
const OPEN_WORK = new Set(['TODO', 'IN_PROGRESS'])
const BLOCKER_FIELDS = ['owner', 'unblock_step', 'needed_by']

/**
 * A receipt is a ticket's latest record at a required evidence level. ENGINEERING_COMPLETE tickets owe
 * only the in-house levels; the rest are the external blocker's to supply.
 */
function requiredLevels(ticket) {
  const levels = Array.isArray(ticket.required_evidence) ? ticket.required_evidence : []
  return ticket.status === 'DONE' ? levels : levels.filter((level) => IN_HOUSE.has(level))
}

function closedTickets(tickets) {
  return tickets.filter((ticket) => CLOSED.has(ticket.status))
}

function receiptsOf(ticket, recordsByTicket) {
  const latest = latestByLevel(recordsByTicket.get(ticket.id) ?? [])
  return requiredLevels(ticket).map((level) => ({ level, record: latest.get(level) }))
}

function missingReceipts(tickets, recordsByTicket) {
  const missing = []
  for (const ticket of closedTickets(tickets)) {
    for (const { level, record } of receiptsOf(ticket, recordsByTicket)) {
      if (record?.result !== 'PASS') missing.push({ ticket: ticket.id, level, reason: record ? 'latest record is not PASS' : 'no record' })
    }
  }
  return missing
}

/**
 * A PASS receipt is stale when a commit after it changed the ticket's scope and does not carry the
 * ticket's own id (the ticket's own merge commit always does, so it never invalidates itself).
 */
function staleReceipts(tickets, recordsByTicket, foreignChanges) {
  const stale = []
  for (const ticket of closedTickets(tickets)) {
    const paths = Array.isArray(ticket.scope_paths) ? ticket.scope_paths : []
    if (paths.length === 0) continue
    for (const { level, record } of receiptsOf(ticket, recordsByTicket)) {
      if (record?.result !== 'PASS') continue
      const changes = foreignChanges({ paths, since: record.recorded_at, commit: record.commit, ticket: ticket.id })
      if (changes.length > 0) stale.push({ ticket: ticket.id, level, recorded_at: record.recorded_at, changed_by: changes })
    }
  }
  return stale
}

/** The nearest transitive dependency that carries its own external_blocker, or null. */
function rootBlocker(ticket, byId) {
  const visited = new Set([ticket.id])
  const queue = [...(ticket.depends_on ?? [])]
  while (queue.length > 0) {
    const dep = byId.get(queue.shift())
    if (!dep || visited.has(dep.id)) continue
    visited.add(dep.id)
    if (dep.external_blocker != null) return dep
    queue.push(...(dep.depends_on ?? []))
  }
  return null
}

/**
 * A row without its own blocker resolves to its root blocker's owner and unblock step (`via` names that
 * ticket); with no root either, the row waits on a lead action and `via` is null.
 */
function blockedRows(tickets, byId) {
  return tickets
    .filter((ticket) => ticket.status === 'BLOCKED_EXTERNAL' || ticket.status === 'ENGINEERING_COMPLETE')
    .map((ticket) => {
      const own = ticket.external_blocker
      const root = own == null ? rootBlocker(ticket, byId) : null
      const blocker = own ?? root?.external_blocker
      return {
        ticket: ticket.id,
        status: ticket.status,
        owner: blocker?.owner ?? null,
        unblock_step: blocker?.unblock_step ?? null,
        needed_by: blocker?.needed_by ?? null,
        inherited: own == null,
        via: root?.id ?? null
      }
    })
}

function matrixProblems(matrix, byId) {
  if (!matrix || !Array.isArray(matrix.rows)) return ['traceability matrix: rows must be an array']
  const problems = []
  const seen = new Set()
  for (const row of matrix.rows) {
    const id = typeof row?.id === 'string' && row.id ? row.id : null
    if (!id) {
      problems.push('traceability row without an id')
      continue
    }
    if (seen.has(id)) problems.push(`${id}: duplicate traceability row`)
    seen.add(id)
    const tickets = Array.isArray(row.tickets) ? row.tickets : []
    if (tickets.length === 0) problems.push(`${id}: no ticket delivers this row`)
    for (const ticketId of tickets) {
      const ticket = byId.get(ticketId)
      if (!ticket) problems.push(`${id}: unknown ticket ${ticketId}`)
      else if (ticket.status === 'CANCELLED') problems.push(`${id}: delivering ticket ${ticketId} is CANCELLED`)
    }
  }
  return problems
}

function kitStatusProblems(tickets, recordsByTicket) {
  const problems = []
  for (const ticket of closedTickets(tickets)) {
    for (const record of latestByLevel(recordsByTicket.get(ticket.id) ?? []).values()) {
      for (const [ref, status] of Object.entries(record.kit_refs ?? {})) {
        if (status === 'NOT_MET') problems.push(`${ticket.id}: ${record.evidence_level} record reports ${ref} NOT_MET`)
        else if (ticket.status === 'DONE' && status !== 'MET') problems.push(`${ticket.id}: DONE but ${record.evidence_level} record reports ${ref} ${status}`)
      }
    }
  }
  return problems
}

function blockerProblems(rows) {
  const problems = []
  for (const row of rows) {
    if (row.inherited && row.status === 'ENGINEERING_COMPLETE') continue
    for (const field of BLOCKER_FIELDS) {
      if (!row[field]) problems.push(`${row.ticket}: ${row.status} row has no external_blocker.${field}`)
    }
  }
  return problems
}

/**
 * @param {{
 *   ledger: object,
 *   recordsByTicket: Map<string, object[]>,
 *   storeProblems?: string[],
 *   matrix: object,
 *   foreignChanges: (query: {paths: string[], since: string, commit: string, ticket: string}) => string[]
 * }} input
 */
export function lintContract({ ledger, recordsByTicket, storeProblems = [], matrix, foreignChanges }) {
  const tickets = Array.isArray(ledger?.tickets) ? ledger.tickets.filter((ticket) => ticket && typeof ticket.id === 'string') : []
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]))
  const missing = missingReceipts(tickets, recordsByTicket)
  const stale = staleReceipts(tickets, recordsByTicket, foreignChanges)
  const blocked = blockedRows(tickets, byId)

  const checks = [
    ['S27-01', 'Every receipt record is well-formed and correctly filed', storeProblems],
    ['S27-02', 'The ledger is internally consistent with its receipts (statuses, dependencies, closure rules)', ledgerProblems(ledger, recordsByTicket)],
    [
      'S27-03',
      'No ticket is still open work',
      tickets.filter((ticket) => OPEN_WORK.has(ticket.status) || !TICKET_STATUSES.includes(ticket.status)).map((ticket) => `${ticket.id}: status ${ticket.status}`)
    ],
    ['S27-04', 'Every closed ticket has a PASS receipt at each level it owes', missing.map((m) => `${m.ticket}: ${m.level} - ${m.reason}`)],
    ['S27-05', 'No receipt is stale against later changes to its ticket scope', stale.map((s) => `${s.ticket}: ${s.level} receipt of ${s.recorded_at} predates ${s.changed_by.join(', ')}`)],
    [
      'S27-06',
      'No closed ticket rests on a withdrawn receipt',
      closedTickets(tickets).flatMap((ticket) =>
        [...latestByLevel(recordsByTicket.get(ticket.id) ?? []).values()]
          .filter((record) => record.result === 'FAIL')
          .map((record) => `${ticket.id}: latest ${record.evidence_level} record is FAIL`)
      )
    ],
    ['S27-07', 'Receipt kit statuses agree with the ticket status', kitStatusProblems(tickets, recordsByTicket)],
    ['S27-08', 'Every BLOCKED_EXTERNAL row names its owner, unblock step and deadline', blockerProblems(blocked)],
    [
      'S27-09',
      'No DONE ticket depends on an open decision',
      tickets
        .filter((ticket) => ticket.status === 'DONE')
        .flatMap((ticket) => (ticket.needs_decision ?? []).filter((id) => ledger.decisions?.[id] === 'OPEN').map((id) => `${ticket.id}: decision ${id} is OPEN`))
    ],
    ['S27-10', 'Every traceability row is delivered by a known, live ticket', matrixProblems(matrix, byId)]
  ].map(([id, title, problems]) => ({ id, title, status: problems.length === 0 ? 'PASS' : 'FAIL', problems }))

  const failed = checks.filter((check) => check.status === 'FAIL')
  return {
    checks,
    missing,
    stale,
    blocked,
    // Engineering completeness is what the ten checks prove; real-environment completeness is separate
    // and stays BLOCKED for as long as any row waits on an outside party.
    engineering: failed.length === 0 ? 'COMPLETE' : 'INCOMPLETE',
    real_environment: blocked.length === 0 ? 'COMPLETE' : 'BLOCKED'
  }
}
