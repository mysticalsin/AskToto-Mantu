#!/usr/bin/env node
/**
 * build-traceability.mjs — M2-0011.
 *
 * Builds a per-ID traceability matrix from a kit/registry ID inventory and the program ticket
 * ledger: every inventory row gets a repo status derived from the ticket(s) that cite it (and
 * any per-kit_ref evidence override), and the check fails closed on anything that does not
 * reconcile — an inventory row no ticket cites, a ticket citing an id absent from the inventory,
 * an unqualified citation that is ambiguous across kits, a `needs_decision` id with no entry in
 * DECISIONS.md, or a BLOCKERS.md row citing a ticket the ledger does not have.
 *
 * This module is deliberately data-free: it takes inventory rows, tickets, decision ids and
 * blocker ticket refs as plain data (see `main`'s CLI contract for where those come from) and
 * contains no Métis 2.0 program content of its own, so its test suite runs anywhere with wholly
 * synthetic fixtures.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

// ---- ID classification ------------------------------------------------------------------------

/**
 * A kit requirement id: `M2-` + an all-letters family segment + exactly two digits (`M2-BASE-01`).
 * Anchored both ends so a longer or shorter digit run, a non-letter family segment, or trailing
 * text never matches — there is no looser "starts with M2-" pattern anywhere in this module.
 */
export const KIT_REQUIREMENT_ID_RE = /^M2-[A-Z]+-\d{2}$/

/** A program ticket id: `M2-` + exactly four digits (`M2-0011`). Anchored both ends. */
export const PROGRAM_TICKET_ID_RE = /^M2-\d{4}$/

/**
 * Classify an id as a kit requirement, a program ticket, or neither. Never matches a bare `M2-`
 * prefix: an id that satisfies neither anchored pattern returns `null` rather than guessing.
 * @param {string} id
 * @returns {'kit-requirement' | 'ticket' | null}
 */
export function classifyM2Id(id) {
  if (KIT_REQUIREMENT_ID_RE.test(id)) return 'kit-requirement'
  if (PROGRAM_TICKET_ID_RE.test(id)) return 'ticket'
  return null
}

// ---- inventory index + citation resolution ----------------------------------------------------

/**
 * @typedef {{ id: string, family?: string, title?: string, kit: string, source_file?: string,
 *   source_ref?: string, parent_task?: string, sources?: unknown[] }} InventoryRow
 */

/**
 * Index inventory rows for citation lookup: by bare id (which can collide across kits — the REF-*
 * namespace does, on purpose) and by `${kit}:${id}` for a kit-qualified citation.
 * @param {InventoryRow[]} rows
 */
export function buildInventoryIndex(rows) {
  const byId = new Map()
  const byKitId = new Map()
  for (const row of rows) {
    const bucket = byId.get(row.id)
    if (bucket) bucket.push(row)
    else byId.set(row.id, [row])
    byKitId.set(`${row.kit}:${row.id}`, row)
  }
  return { byId, byKitId }
}

/**
 * Resolve one kit_refs citation against an inventory index. A `kit:id` citation always resolves
 * to that exact row. A bare citation resolves only when the id is unique across every kit; an id
 * shared by two or more kits (the REF-* namespaces) refuses as `ambiguous` rather than picking one
 * — the ticket has to name the kit.
 * @param {string} citation
 * @param {{ byId: Map<string, InventoryRow[]>, byKitId: Map<string, InventoryRow> }} index
 * @returns {{ ok: boolean, row?: InventoryRow, reason?: 'unknown' | 'ambiguous' }} a flat shape
 *   (not a discriminated union) so callers may read `.row` or `.reason` directly — the field the
 *   `ok` value does not select is simply absent, i.e. `undefined`
 */
export function resolveCitation(citation, index) {
  const qualified = /^(.+?):(.+)$/.exec(citation)
  if (qualified) {
    const [, kit, id] = qualified
    const row = index.byKitId.get(`${kit}:${id}`)
    return row ? { ok: true, row } : { ok: false, reason: 'unknown' }
  }
  const rows = index.byId.get(citation)
  if (!rows || rows.length === 0) return { ok: false, reason: 'unknown' }
  if (rows.length > 1) return { ok: false, reason: 'ambiguous' }
  return { ok: true, row: rows[0] }
}

// ---- status vocabulary -------------------------------------------------------------------------

/**
 * Rank, least to most advanced. Used only to pick a winner when several tickets (or a ticket and
 * an evidence override) disagree about the same row — never exposed as an ordering guarantee
 * beyond "higher rank wins". CANCELLED ranks below NOT_STARTED: a row one ticket cancelled but
 * another is actively working stays visible as work in flight, not as abandoned.
 */
const STATUS_RANK = {
  CANCELLED: 0,
  NOT_STARTED: 1,
  DEFERRED: 2,
  BLOCKED_EXTERNAL: 3,
  IN_PROGRESS: 4,
  ENGINEERING_COMPLETE: 5,
  DONE: 6
}

/**
 * Normalize a raw ticket/evidence status: `TODO` renames to `NOT_STARTED`, every other recognized
 * value passes through unchanged, and an unrecognized value throws rather than being guessed at.
 * @param {string} status
 */
function normalizeStatus(status) {
  if (status === 'TODO') return 'NOT_STARTED'
  if (Object.prototype.hasOwnProperty.call(STATUS_RANK, status)) return status
  throw new Error(`unrecognized status: ${status}`)
}

/** @param {{ status: string }} ticket */
export function statusForTicket(ticket) {
  return normalizeStatus(ticket.status)
}

/**
 * The most-advanced status among several (a row cited by more than one ticket takes the furthest
 * along). Throws on an unrecognized status rather than silently ranking it last.
 * @param {string[]} statuses
 */
export function mergeStatuses(statuses) {
  for (const status of statuses) {
    if (!Object.prototype.hasOwnProperty.call(STATUS_RANK, status)) {
      throw new Error(`mergeStatuses: unrecognized status: ${status}`)
    }
  }
  return statuses.reduce((best, status) => (STATUS_RANK[status] > STATUS_RANK[best] ? status : best))
}

/**
 * @typedef {{ ticket: { id: string, status: string, evidence?: unknown }, citation: string }} Citation
 */

/**
 * The repo status for one inventory row: `UNMAPPED` when nothing cites it, otherwise the
 * most-advanced status across every citing ticket — where a ticket's `evidence` array carries a
 * `{ kit_ref, status }` record naming this exact citation, that record's status overrides the
 * ticket's own status for this row only. A ticket whose `evidence` is absent or not an array (the
 * ledger's current shape, a single provenance object) simply has no override.
 * @param {InventoryRow} _row unused directly; kept so the signature reads as "row, its citations"
 * @param {Citation[]} citations
 */
export function computeRowStatus(_row, citations) {
  if (citations.length === 0) return 'UNMAPPED'
  const statuses = citations.map(({ ticket, citation }) => {
    const evidence = Array.isArray(ticket.evidence) ? ticket.evidence : []
    const override = evidence.find((e) => e && e.kit_ref === citation)
    return override ? normalizeStatus(override.status) : statusForTicket(ticket)
  })
  return mergeStatuses(statuses)
}

// ---- markdown extraction (DECISIONS.md / BLOCKERS.md) ------------------------------------------

/**
 * Every bare `D-<n>` decision id in DECISIONS.md — never the `D-<n>` suffix embedded inside
 * `OD-<n>` or `PD-<n>` (a negative lookbehind refuses a preceding letter).
 * @param {string} markdown
 * @returns {Set<string>}
 */
export function extractDecisionIds(markdown) {
  const ids = new Set()
  for (const match of markdown.matchAll(/(?<![A-Za-z])(D-\d+)/g)) ids.add(match[1])
  return ids
}

const TABLE_SEPARATOR_RE = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/
const LEADING_TICKET_NUMBER_RE = /^\s*(\d+)/

/** @param {string} line */
function splitTableRow(line) {
  let inner = line.trim()
  if (inner.startsWith('|')) inner = inner.slice(1)
  if (inner.endsWith('|')) inner = inner.slice(0, -1)
  return inner.split('|')
}

/**
 * Every ticket referenced by a "Ticket" column, across every markdown table in BLOCKERS.md — the
 * document has one table per owner-role section, each with its own column layout, so this walks
 * line by line rather than assuming a single table. A cell is read as its leading digit run (some
 * rows carry a trailing description after the number, e.g. `0007: Provision the QA host`), always
 * returned `M2-`-prefixed — a bare `M2-` prefix is never accepted as a match on its own.
 * @param {string} markdown
 * @returns {Set<string>}
 */
export function extractBlockerTicketRefs(markdown) {
  const lines = markdown.split('\n')
  const refs = new Set()
  let ticketColumn = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim().startsWith('|')) {
      ticketColumn = null
      continue
    }
    const nextLine = lines[i + 1] ?? ''
    if (TABLE_SEPARATOR_RE.test(nextLine.trim())) {
      const header = splitTableRow(line)
      const idx = header.findIndex((cell) => cell.trim() === 'Ticket')
      ticketColumn = idx >= 0 ? idx : null
      i += 1 // consume the separator row too
      continue
    }
    if (ticketColumn === null) continue
    const cells = splitTableRow(line)
    if (ticketColumn >= cells.length) continue
    const match = LEADING_TICKET_NUMBER_RE.exec(cells[ticketColumn].trim())
    if (match) refs.add(`M2-${match[1]}`)
  }
  return refs
}

// ---- the matrix ---------------------------------------------------------------------------------

/**
 * @typedef {{ id: string, family?: string, title?: string, kit: string, tickets: string[],
 *   status: string }} TraceRow
 * @typedef {{ type: 'unmapped', id: string, kit: string }
 *   | { type: 'dangling-ticket-ref', ticketId: string, citation: string }
 *   | { type: 'ambiguous-citation', ticketId: string, citation: string }
 *   | { type: 'unresolved-decision', ticketId: string, decisionId: string }
 *   | { type: 'dangling-blocker-ref', ticketId: string }} TraceError
 */

/**
 * Build the traceability matrix and its errors from an inventory, the ticket ledger, the decision
 * ids DECISIONS.md defines, and the ticket ids BLOCKERS.md cites. Pure function — no file I/O; see
 * `main` for the CLI that reads these four inputs from disk.
 * @param {{ inventory: InventoryRow[], tickets: unknown[], decisionIds: Set<string>,
 *   blockerTicketRefs: Set<string> }} input
 * @returns {{ rows: TraceRow[], errors: TraceError[] }}
 */
export function buildTraceability({ inventory, tickets, decisionIds, blockerTicketRefs }) {
  const index = buildInventoryIndex(inventory)
  const citationsByRow = new Map(inventory.map((row) => [row, /** @type {Citation[]} */ ([])]))
  const errors = []

  for (const ticket of tickets) {
    for (const citation of ticket.kit_refs ?? []) {
      const resolved = resolveCitation(citation, index)
      if (!resolved.ok) {
        errors.push({
          type: resolved.reason === 'ambiguous' ? 'ambiguous-citation' : 'dangling-ticket-ref',
          ticketId: ticket.id,
          citation
        })
        continue
      }
      citationsByRow.get(resolved.row).push({ ticket, citation })
    }
    for (const decisionId of ticket.needs_decision ?? []) {
      if (!decisionIds.has(decisionId)) {
        errors.push({ type: 'unresolved-decision', ticketId: ticket.id, decisionId })
      }
    }
  }

  const rows = inventory.map((row) => {
    const citations = citationsByRow.get(row)
    if (citations.length === 0) errors.push({ type: 'unmapped', id: row.id, kit: row.kit })
    return {
      ...row,
      tickets: [...new Set(citations.map((c) => c.ticket.id))],
      status: computeRowStatus(row, citations)
    }
  })

  const ticketIds = new Set(tickets.map((t) => t.id))
  for (const ticketId of blockerTicketRefs) {
    if (!ticketIds.has(ticketId)) errors.push({ type: 'dangling-blocker-ref', ticketId })
  }

  return { rows, errors }
}

// ---- rendering ------------------------------------------------------------------------------

/** @param {{ rows: TraceRow[], errors: TraceError[] }} result */
export function renderMarkdown(result) {
  const header = '| ID | Family | Title | Kit | Tickets | Status |\n|---|---|---|---|---|---|'
  const lines = result.rows.map((row) => {
    const tickets = row.tickets.length > 0 ? row.tickets.join(', ') : '—'
    return `| ${row.id} | ${row.family ?? ''} | ${row.title ?? ''} | ${row.kit} | ${tickets} | ${row.status} |`
  })
  return [
    '# Traceability: kit/registry IDs to program tickets',
    '',
    `Generated from the repository's own ID inventory and ledger. ${result.rows.length} row(s), ${result.errors.length} error(s).`,
    '',
    header,
    ...lines,
    ''
  ].join('\n')
}

/** @param {{ rows: TraceRow[], errors: TraceError[] }} result */
export function renderJson(result) {
  return {
    rows: result.rows.map((row) => ({
      id: row.id,
      family: row.family,
      title: row.title,
      kit: row.kit,
      tickets: row.tickets,
      status: row.status
    })),
    errors: result.errors,
    summary: { total: result.rows.length, errorCount: result.errors.length }
  }
}

// ---- CLI -----------------------------------------------------------------------------------

/** @param {string[]} argv */
function parseArgs(argv) {
  const args = { check: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--check') {
      args.check = true
      continue
    }
    if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
      args[key] = argv[++i]
    }
  }
  return args
}

/** @param {TraceError} error */
function formatError(error) {
  switch (error.type) {
    case 'unmapped':
      return `unmapped id ${error.id} (kit ${error.kit}) — no ticket cites it`
    case 'dangling-ticket-ref':
      return `${error.ticketId} cites ${error.citation}, which is not in the inventory`
    case 'ambiguous-citation':
      return `${error.ticketId} cites ${error.citation}, which exists in more than one kit — qualify it as kit:id`
    case 'unresolved-decision':
      return `${error.ticketId} needs_decision ${error.decisionId}, which has no entry in DECISIONS.md`
    case 'dangling-blocker-ref':
      return `BLOCKERS.md cites ${error.ticketId}, which is not in the ledger`
    default:
      return JSON.stringify(error)
  }
}

/**
 * The `--check` CLI contract (ticket verification step): read the four inputs, build the matrix,
 * and either exit 1 naming every error (`--check`, or implicitly whenever errors exist) or write
 * `--out-md` / `--out-json` when both are clean.
 * @param {string[]} argv
 */
export function main(argv) {
  const args = parseArgs(argv)
  const ticketsRaw = JSON.parse(readFileSync(args.tickets, 'utf8'))
  const tickets = Array.isArray(ticketsRaw) ? ticketsRaw : ticketsRaw.tickets
  const inventory = JSON.parse(readFileSync(args.inventory, 'utf8'))
  const decisionIds = extractDecisionIds(readFileSync(args.decisions, 'utf8'))
  const blockerTicketRefs = extractBlockerTicketRefs(readFileSync(args.blockers, 'utf8'))

  const result = buildTraceability({ inventory, tickets, decisionIds, blockerTicketRefs })

  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`[trace] ${formatError(error)}`)
    console.error(`[trace] ${result.errors.length} error(s) — see above`)
    process.exit(1)
    return
  }

  console.log(`[trace] OK — ${result.rows.length} row(s), 0 errors`)

  if (args.outMd) {
    if (!existsSync(dirname(args.outMd))) mkdirSync(dirname(args.outMd), { recursive: true })
    writeFileSync(args.outMd, renderMarkdown(result), 'utf8')
  }
  if (args.outJson) {
    if (!existsSync(dirname(args.outJson))) mkdirSync(dirname(args.outJson), { recursive: true })
    writeFileSync(args.outJson, `${JSON.stringify(renderJson(result), null, 1)}\n`, 'utf8')
  }
}

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isMainModule) main(process.argv.slice(2))
