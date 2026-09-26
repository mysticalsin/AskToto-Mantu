#!/usr/bin/env node
/**
 * build-traceability.mjs — M2-0011.
 *
 * Builds a per-ID traceability matrix from a kit/registry ID inventory and the program ticket
 * ledger: every inventory row gets a repo status derived from the ticket(s) that cite it (and any
 * per-kit_ref ADR-017 evidence override), and the check fails closed on anything that does not
 * reconcile — an inventory row no live ticket cites, a ticket citing an id absent from the
 * inventory or citing a program ticket id where a kit requirement id belongs, an unqualified
 * citation that is ambiguous across kits, a malformed ledger ticket id, an unresolved
 * `needs_decision`, or a BLOCKERS.md row citing a ticket the ledger does not have.
 *
 * This module is deliberately data-free: it takes inventory rows, tickets, decision ids, blocker
 * ticket refs and (optionally) per-ticket evidence overrides as plain data — see `main`'s CLI
 * contract for where those come from — and contains no Métis 2.0 program content of its own, so
 * its test suite runs anywhere with wholly synthetic fixtures.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

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
 * Resolve one kit_refs citation against an inventory index.
 * @param {string} citation
 * @param {{ byId: Map<string, InventoryRow[]>, byKitId: Map<string, InventoryRow> }} index
 * @returns {{ ok: true, row: InventoryRow } | { ok: false, reason: 'unknown' | 'ambiguous' }}
 *   `unknown` when no row anywhere matches; `ambiguous` when a bare (unqualified) citation matches
 *   an id shared by two or more kits and must instead be qualified as `kit:id`.
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

/** @param {string} status */
function assertKnownStatus(status) {
  if (!Object.prototype.hasOwnProperty.call(STATUS_RANK, status)) {
    throw new Error(`unrecognized status: ${status}`)
  }
}

/**
 * Normalize a raw ticket/evidence status: `TODO` renames to `NOT_STARTED`, every other recognized
 * value passes through unchanged, and an unrecognized value throws rather than being guessed at.
 * @param {string} status
 */
function normalizeStatus(status) {
  if (status === 'TODO') return 'NOT_STARTED'
  assertKnownStatus(status)
  return status
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
  for (const status of statuses) assertKnownStatus(status)
  return statuses.reduce((best, status) => (STATUS_RANK[status] > STATUS_RANK[best] ? status : best))
}

// ---- ADR-017 evidence overrides ----------------------------------------------------------------

const KNOWN_KIT_STATUSES = new Set(['MET', 'PARTIAL', 'BLOCKED', 'NOT_MET'])

/**
 * Maps one per-kit_ref ADR-017 evidence status onto this module's row-status vocabulary, given the
 * citing ticket's own (already normalized) status. One mapping, defined here and nowhere else:
 *   - `BLOCKED` always becomes `BLOCKED_EXTERNAL`, regardless of the ticket's own status.
 *   - `MET` takes the ticket's own status unchanged — the evidence confirms it, it does not raise it.
 *   - `PARTIAL` and `NOT_MET` never rank above `IN_PROGRESS`: a kit_ref the evidence itself says
 *     isn't there yet can't make the row ENGINEERING_COMPLETE or DONE, however advanced the ticket is.
 * @param {string} kitStatus one of the ADR-017 KIT_STATUSES: MET, PARTIAL, BLOCKED or NOT_MET
 * @param {string} ticketStatus a normalized row-status value (a key of STATUS_RANK)
 * @returns {string}
 */
export function applyEvidenceOverride(kitStatus, ticketStatus) {
  if (!KNOWN_KIT_STATUSES.has(kitStatus)) throw new Error(`unrecognized kit_ref evidence status: ${kitStatus}`)
  if (kitStatus === 'BLOCKED') return 'BLOCKED_EXTERNAL'
  if (kitStatus === 'MET') return ticketStatus
  return STATUS_RANK[ticketStatus] > STATUS_RANK.IN_PROGRESS ? 'IN_PROGRESS' : ticketStatus
}

/**
 * @typedef {{ ticket: { id: string, status: string }, citation: string }} Citation
 */

/**
 * The repo status for one inventory row: `UNMAPPED` when nothing cites it, otherwise the
 * most-advanced status across every citing ticket, with each citation's status first passed
 * through `applyEvidenceOverride` when `evidenceByTicket` carries an override for that exact
 * ticket + kit_ref pair. A ticket with no entry in `evidenceByTicket` simply has no override.
 * @param {Citation[]} citations
 * @param {Map<string, Record<string, string>>} [evidenceByTicket] ticket id -> { kit_ref -> ADR-017
 *   kit status }, e.g. the latest PASS record's `kit_refs` for that ticket (see `main`'s `--evidence`)
 */
export function computeRowStatus(citations, evidenceByTicket = new Map()) {
  if (citations.length === 0) return 'UNMAPPED'
  const statuses = citations.map(({ ticket, citation }) => {
    const ticketStatus = statusForTicket(ticket)
    const kitStatus = evidenceByTicket.get(ticket.id)?.[citation]
    return kitStatus ? applyEvidenceOverride(kitStatus, ticketStatus) : ticketStatus
  })
  return mergeStatuses(statuses)
}

// ---- markdown extraction (DECISIONS.md / BLOCKERS.md) ------------------------------------------

/**
 * Every decision id defined as a table row's first cell in DECISIONS.md (`| D-3 | ... |`) — never
 * a bare `D-<n>` mentioned in prose, and never the `D-<n>` suffix embedded inside `OD-<n>` or
 * `PD-<n>`, since those never begin a cell with exactly `D-`.
 * @param {string} markdown
 * @returns {Set<string>}
 */
export function extractDecisionIds(markdown) {
  const ids = new Set()
  for (const line of markdown.split('\n')) {
    const match = /^\|\s*(D-\d+)\s*\|/.exec(line)
    if (match) ids.add(match[1])
  }
  return ids
}

const TABLE_SEPARATOR_RE = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/
const TICKET_COLUMN_HEADERS = new Set(['Ticket', 'Affected tickets'])
const BARE_TICKET_NUMBER_RE = /^(\d{4})(?!\d)/

/** @param {string} line */
function splitTableRow(line) {
  let inner = line.trim()
  if (inner.startsWith('|')) inner = inner.slice(1)
  if (inner.endsWith('|')) inner = inner.slice(0, -1)
  return inner.split('|')
}

/**
 * Parses one ticket-column cell item (already split on comma and trimmed) into a program ticket
 * id: `M2-NNNN` directly, or a bare 4-digit run at the start (some rows carry a trailing
 * description after the number, e.g. `0007: Provision the QA host`) prefixed with `M2-`. A bare
 * `M2-` prefix is never accepted on its own. Returns `null` for a non-empty item that parses as
 * neither — the caller reports that as malformed rather than skipping it.
 * @param {string} item
 * @returns {string | null}
 */
function parseTicketCellItem(item) {
  if (PROGRAM_TICKET_ID_RE.test(item)) return item
  const bare = BARE_TICKET_NUMBER_RE.exec(item)
  return bare ? `M2-${bare[1]}` : null
}

/**
 * Every ticket BLOCKERS.md cites: every item (comma-separated lists included, not just the first)
 * in a ticket-bearing column's cell — a column headed exactly `Ticket` or `Affected tickets`,
 * across every markdown table in the document, since it has one table per owner-role section, each
 * with its own column layout — plus every bare `M2-\d{4}` token anywhere in the document, which
 * catches tables (such as the escalated-decisions table's prior-blocker references) that cite a
 * ticket outside a ticket-bearing column. A non-empty ticket-bearing cell item that parses as
 * neither form is reported as malformed rather than silently skipped.
 * @param {string} markdown
 * @returns {{ refs: Set<string>, malformed: string[] }}
 */
export function extractBlockerTicketRefs(markdown) {
  const refs = new Set()
  const malformed = []

  for (const match of markdown.matchAll(/M2-\d{4}/g)) refs.add(match[0])

  const lines = markdown.split('\n')
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
      const idx = header.findIndex((cell) => TICKET_COLUMN_HEADERS.has(cell.trim()))
      ticketColumn = idx >= 0 ? idx : null
      i += 1 // consume the separator row too
      continue
    }
    if (ticketColumn === null) continue
    const cells = splitTableRow(line)
    if (ticketColumn >= cells.length) continue
    for (const item of cells[ticketColumn].split(',')) {
      const trimmed = item.trim()
      if (trimmed.length === 0) continue
      const ref = parseTicketCellItem(trimmed)
      if (ref) refs.add(ref)
      else malformed.push(trimmed)
    }
  }

  return { refs, malformed }
}

// ---- the matrix ---------------------------------------------------------------------------------

/**
 * @typedef {{ id: string, family?: string, title?: string, kit: string, tickets: string[],
 *   status: string }} TraceRow
 * @typedef {{ type: 'unmapped', id: string, kit: string }
 *   | { type: 'dangling-ticket-ref', ticketId: string, citation: string }
 *   | { type: 'ambiguous-citation', ticketId: string, citation: string }
 *   | { type: 'ticket-ref-in-kit-refs', ticketId: string, citation: string }
 *   | { type: 'malformed-ticket-id', ticketId: string }
 *   | { type: 'unresolved-decision', ticketId: string, decisionId: string }
 *   | { type: 'dangling-blocker-ref', ticketId: string }
 *   | { type: 'malformed-blocker-ticket-ref', cell: string }} TraceError
 */

/**
 * Build the traceability matrix and its errors from an inventory, the ticket ledger, the decision
 * ids DECISIONS.md defines, the ticket ids BLOCKERS.md cites (plus any cell it could not parse),
 * and per-ticket ADR-017 evidence overrides. Pure function — no file I/O; see `main` for the CLI
 * that reads these inputs from disk.
 * @param {{ inventory: InventoryRow[], tickets: unknown[], decisionIds: Set<string>,
 *   blockerTicketRefs: Set<string>, malformedBlockerRefs?: string[],
 *   evidenceByTicket?: Map<string, Record<string, string>> }} input
 * @returns {{ rows: TraceRow[], errors: TraceError[] }}
 */
export function buildTraceability({
  inventory,
  tickets,
  decisionIds,
  blockerTicketRefs,
  malformedBlockerRefs = [],
  evidenceByTicket = new Map()
}) {
  const index = buildInventoryIndex(inventory)
  const citationsByRow = new Map(inventory.map((row) => [row, /** @type {Citation[]} */ ([])]))
  const errors = []

  for (const ticket of tickets) {
    if (!PROGRAM_TICKET_ID_RE.test(ticket.id)) {
      errors.push({ type: 'malformed-ticket-id', ticketId: ticket.id })
    }

    for (const citation of ticket.kit_refs ?? []) {
      if (classifyM2Id(citation) === 'ticket') {
        errors.push({ type: 'ticket-ref-in-kit-refs', ticketId: ticket.id, citation })
        continue
      }
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
    // A row cited only by CANCELLED tickets has no real coverage — cancelling a ticket must be
    // able to turn a mapped row back into an unmapped one, since catching exactly that is this
    // check's job. The cancelled ticket still appears in `tickets` below, for visibility.
    const coveringCitations = citations.filter((c) => c.ticket.status !== 'CANCELLED')
    if (coveringCitations.length === 0) errors.push({ type: 'unmapped', id: row.id, kit: row.kit })
    return {
      ...row,
      tickets: [...new Set(citations.map((c) => c.ticket.id))],
      status: computeRowStatus(coveringCitations, evidenceByTicket)
    }
  })

  const ticketIds = new Set(tickets.map((t) => t.id))
  for (const ticketId of blockerTicketRefs) {
    if (!ticketIds.has(ticketId)) errors.push({ type: 'dangling-blocker-ref', ticketId })
  }
  for (const cell of malformedBlockerRefs) {
    errors.push({ type: 'malformed-blocker-ticket-ref', cell })
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

const USAGE =
  'usage: build-traceability.mjs --tickets <path> --inventory <path> --decisions <path> ' +
  '--blockers <path> [--evidence <dir>] (--check | --out-md <path> --out-json <path>)'

const CLI_OPTIONS = {
  check: { type: 'boolean', default: false },
  tickets: { type: 'string' },
  inventory: { type: 'string' },
  decisions: { type: 'string' },
  blockers: { type: 'string' },
  evidence: { type: 'string' },
  'out-md': { type: 'string' },
  'out-json': { type: 'string' }
}

const REQUIRED_ARGS = ['tickets', 'inventory', 'decisions', 'blockers']

/** @param {string} message */
function usageExit(message) {
  console.error(`${USAGE} — ${message}`)
  process.exit(2)
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
    case 'ticket-ref-in-kit-refs':
      return `${error.ticketId} cites ${error.citation} in kit_refs, but that id is a program ticket, not a kit requirement`
    case 'malformed-ticket-id':
      return `ledger ticket id "${error.ticketId}" does not match ${PROGRAM_TICKET_ID_RE}`
    case 'unresolved-decision':
      return `${error.ticketId} needs_decision ${error.decisionId}, which has no entry in DECISIONS.md`
    case 'dangling-blocker-ref':
      return `BLOCKERS.md cites ${error.ticketId}, which is not in the ledger`
    case 'malformed-blocker-ticket-ref':
      return `BLOCKERS.md cites "${error.cell}", which does not parse as a ticket reference`
  }
}

/**
 * Reads per-kit_ref evidence overrides from the ADR-017 record store (M2-0002's
 * scripts/evidence/record.mjs) for every ticket that has one, as the `kit_refs` map of its latest
 * PASS record — the last one in file order, since the store is an append-only log where the last
 * line for a ticket governs. A ticket with no PASS record simply has no entry in the result. This
 * never re-parses the JSONL store itself: it delegates entirely to M2-0002's reader.
 * @param {string | undefined} evidenceDir
 * @returns {Promise<Map<string, Record<string, string>>>}
 */
async function loadEvidenceByTicket(evidenceDir) {
  if (!evidenceDir) return new Map()
  let readRecordStore
  try {
    ;({ readRecordStore } = await import('../evidence/record.mjs'))
  } catch (error) {
    throw new Error(
      `--evidence requires scripts/evidence/record.mjs (M2-0002), which could not be imported: ${error.message}`
    )
  }
  const { recordsByTicket, problems } = readRecordStore(evidenceDir)
  if (problems.length > 0) throw new Error(`--evidence: ${problems.join('; ')}`)
  const evidenceByTicket = new Map()
  for (const [ticketId, records] of recordsByTicket) {
    const latestPass = [...records].reverse().find((record) => record.result === 'PASS')
    if (latestPass) evidenceByTicket.set(ticketId, latestPass.kit_refs)
  }
  return evidenceByTicket
}

/**
 * The CLI contract (ticket verification step): read the inputs, build the matrix, and either exit
 * 1 naming every error (whenever any exist) or, when clean and `--check` was not given, write
 * `--out-md` / `--out-json`. `--check` only ever validates: given alongside `--out-md`/`--out-json`
 * it never writes them, clean or not.
 * @param {string[]} argv
 */
export async function main(argv) {
  let values
  try {
    ;({ values } = parseArgs({ args: argv, options: CLI_OPTIONS, strict: true }))
  } catch (error) {
    return usageExit(error.message)
  }

  const missing = REQUIRED_ARGS.filter((key) => typeof values[key] !== 'string')
  if (missing.length > 0) {
    return usageExit(`missing required argument(s): ${missing.map((key) => `--${key}`).join(', ')}`)
  }

  const { tickets } = JSON.parse(readFileSync(values.tickets, 'utf8'))
  const inventory = JSON.parse(readFileSync(values.inventory, 'utf8'))
  const decisionIds = extractDecisionIds(readFileSync(values.decisions, 'utf8'))
  const { refs: blockerTicketRefs, malformed: malformedBlockerRefs } = extractBlockerTicketRefs(
    readFileSync(values.blockers, 'utf8')
  )

  let evidenceByTicket
  try {
    evidenceByTicket = await loadEvidenceByTicket(values.evidence)
  } catch (error) {
    console.error(`[trace] ${error.message}`)
    process.exit(1)
  }

  const result = buildTraceability({
    inventory,
    tickets,
    decisionIds,
    blockerTicketRefs,
    malformedBlockerRefs,
    evidenceByTicket
  })

  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`[trace] ${formatError(error)}`)
    console.error(`[trace] ${result.errors.length} error(s) — see above`)
    process.exit(1)
  }

  console.log(`[trace] OK — ${result.rows.length} row(s), 0 errors`)

  if (values.check) return

  if (values['out-md']) {
    mkdirSync(dirname(values['out-md']), { recursive: true })
    writeFileSync(values['out-md'], renderMarkdown(result), 'utf8')
  }
  if (values['out-json']) {
    mkdirSync(dirname(values['out-json']), { recursive: true })
    writeFileSync(values['out-json'], `${JSON.stringify(renderJson(result), null, 1)}\n`, 'utf8')
  }
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedAsScript) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
