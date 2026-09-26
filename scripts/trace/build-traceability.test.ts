import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  KIT_REQUIREMENT_ID_RE,
  PROGRAM_TICKET_ID_RE,
  applyEvidenceOverride,
  buildInventoryIndex,
  buildTraceability,
  classifyM2Id,
  computeRowStatus,
  extractBlockerTicketRefs,
  extractDecisionIds,
  main,
  mergeGoverningKitRefs,
  mergeStatuses,
  renderJson,
  renderMarkdown,
  resolveCitation,
  statusForTicket
} from './build-traceability.mjs'

// ---- fixtures (wholly synthetic — no real Métis 2.0 program data) ----------

function row(overrides = {}) {
  return {
    id: 'FOO-01',
    family: 'FOO',
    title: 'A fake requirement',
    kit: 'kitA',
    source_file: 'plan/registry.json',
    source_ref: 'foo[0]',
    parent_task: '',
    ...overrides
  }
}

function ticket(overrides = {}) {
  return {
    id: 'M2-9001',
    title: 'A fake ticket',
    kit_refs: [],
    finding_refs: [],
    needs_decision: [],
    status: 'TODO',
    evidence: null,
    ...overrides
  }
}

describe('classifyM2Id — kit requirement vs program ticket, never a bare M2- prefix', () => {
  it.each([
    ['M2-BASE-01', 'kit-requirement'],
    ['M2-VOICE-99', 'kit-requirement'],
    ['M2-0011', 'ticket'],
    ['M2-0001', 'ticket']
  ])('%s classifies as %s', (id, expected) => {
    expect(classifyM2Id(id)).toBe(expected)
  })

  it.each([
    'M2-',
    'M2-FOO', // kit requirement needs a trailing -NN
    'M2-BASE-1', // one digit, not two
    'M2-BASE-001', // three digits, not two
    'M2-A1-01', // segment must be letters only
    'M2-1', // ticket needs exactly 4 digits
    'M2-001', // three digits
    'M2-00011', // five digits
    'xM2-0011' // not anchored at the start
  ])('%s matches neither pattern', (id) => {
    expect(classifyM2Id(id)).toBeNull()
  })

  it.each([
    'M2-BASE-01', 'M2-VOICE-99', 'M2-0011', 'M2-0001',
    'M2-', 'M2-FOO', 'M2-BASE-1', 'M2-BASE-001', 'M2-A1-01', 'M2-1', 'M2-001', 'M2-00011', 'xM2-0011'
  ])('the two patterns never both match %s', (id) => {
    expect(KIT_REQUIREMENT_ID_RE.test(id) && PROGRAM_TICKET_ID_RE.test(id)).toBe(false)
  })
})

describe('REF-* namespace disambiguation by kit tag', () => {
  const rows = [
    row({ id: 'REF-01', kit: 'kitA', title: 'kitA source' }),
    row({ id: 'REF-01', kit: 'kitB', title: 'kitB source' }),
    row({ id: 'TASK-003', kit: 'kitA', title: 'unique across kits' })
  ]
  const index = buildInventoryIndex(rows)

  it('resolves an unqualified citation when the id is unique across kits', () => {
    const result = resolveCitation('TASK-003', index)
    expect(result.ok).toBe(true)
    expect(result.ok && result.row.kit).toBe('kitA')
  })

  it('refuses an unqualified citation of an id shared by two kits', () => {
    const result = resolveCitation('REF-01', index)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toBe('ambiguous')
  })

  it('resolves a kit-qualified citation to the exact row', () => {
    const a = resolveCitation('kitA:REF-01', index)
    const b = resolveCitation('kitB:REF-01', index)
    expect(a.ok && a.row.title).toBe('kitA source')
    expect(b.ok && b.row.title).toBe('kitB source')
  })

  it('reports an unknown citation that matches no row in any kit', () => {
    const result = resolveCitation('NOPE-99', index)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toBe('unknown')
  })
})

describe('statusForTicket — ticket status vocabulary', () => {
  it('renames TODO to NOT_STARTED', () => {
    expect(statusForTicket(ticket({ status: 'TODO' }))).toBe('NOT_STARTED')
  })

  it.each(['IN_PROGRESS', 'ENGINEERING_COMPLETE', 'BLOCKED_EXTERNAL', 'DEFERRED', 'DONE', 'CANCELLED'])(
    'passes %s through unchanged',
    (status) => {
      expect(statusForTicket(ticket({ status }))).toBe(status)
    }
  )

  it('fails closed on an unrecognized ticket status rather than guessing', () => {
    expect(() => statusForTicket(ticket({ status: 'WAT' }))).toThrow()
  })
})

describe('mergeStatuses — most-advanced status wins', () => {
  it('prefers DONE over everything else', () => {
    expect(mergeStatuses(['NOT_STARTED', 'DONE', 'IN_PROGRESS'])).toBe('DONE')
  })

  it('prefers IN_PROGRESS over NOT_STARTED and CANCELLED', () => {
    expect(mergeStatuses(['CANCELLED', 'NOT_STARTED', 'IN_PROGRESS'])).toBe('IN_PROGRESS')
  })

  it('fails closed on an unrecognized status rather than ranking it last', () => {
    expect(() => mergeStatuses(['DONE', 'WAT'])).toThrow()
  })
})

describe('applyEvidenceOverride — the one ADR-017 kit-status mapping', () => {
  it('BLOCKED always becomes BLOCKED_EXTERNAL, regardless of the ticket status', () => {
    expect(applyEvidenceOverride('BLOCKED', 'IN_PROGRESS')).toBe('BLOCKED_EXTERNAL')
    expect(applyEvidenceOverride('BLOCKED', 'DONE')).toBe('BLOCKED_EXTERNAL')
  })

  it('MET takes the ticket status unchanged', () => {
    expect(applyEvidenceOverride('MET', 'DONE')).toBe('DONE')
    expect(applyEvidenceOverride('MET', 'NOT_STARTED')).toBe('NOT_STARTED')
  })

  it.each(['PARTIAL', 'NOT_MET'])('%s caps a more-advanced ticket status at IN_PROGRESS', (kitStatus) => {
    expect(applyEvidenceOverride(kitStatus, 'DONE')).toBe('IN_PROGRESS')
    expect(applyEvidenceOverride(kitStatus, 'ENGINEERING_COMPLETE')).toBe('IN_PROGRESS')
  })

  it.each(['PARTIAL', 'NOT_MET'])('%s leaves a ticket status already at or below IN_PROGRESS unchanged', (kitStatus) => {
    expect(applyEvidenceOverride(kitStatus, 'IN_PROGRESS')).toBe('IN_PROGRESS')
    expect(applyEvidenceOverride(kitStatus, 'NOT_STARTED')).toBe('NOT_STARTED')
    expect(applyEvidenceOverride(kitStatus, 'DEFERRED')).toBe('DEFERRED')
  })

  it('fails closed on an unrecognized kit status rather than guessing', () => {
    expect(() => applyEvidenceOverride('WAT', 'DONE')).toThrow()
  })
})

describe('mergeGoverningKitRefs — derives status from every still-governing (latest-per-level) record', () => {
  it('a kit_ref only one level\'s governing record mentions takes that status unchanged', () => {
    const byLevel = new Map([['LOCALLY_TESTED', { kit_refs: { 'FOO-01': 'MET' } }]])
    expect(mergeGoverningKitRefs(byLevel)).toEqual({ 'FOO-01': 'MET' })
  })

  it('reads kit_refs from a governing record whose own result is FAIL, not only from a PASS', () => {
    const byLevel = new Map([['LOCALLY_TESTED', { result: 'FAIL', kit_refs: { 'FOO-01': 'NOT_MET' } }]])
    expect(mergeGoverningKitRefs(byLevel)).toEqual({ 'FOO-01': 'NOT_MET' })
  })

  it('a later-level FAIL withdraws an earlier-level PASS\'s more advanced status for the same kit_ref', () => {
    // Both are governing (one per level) — this is not "earlier vs later in one file", it's two
    // levels whose governing records disagree, which is exactly when the least-advanced wins.
    const byLevel = new Map([
      ['LOCALLY_TESTED', { result: 'PASS', kit_refs: { 'FOO-01': 'MET' } }],
      ['LIVE_VERIFIED', { result: 'FAIL', kit_refs: { 'FOO-01': 'NOT_MET' } }]
    ])
    expect(mergeGoverningKitRefs(byLevel)).toEqual({ 'FOO-01': 'NOT_MET' })
  })

  it.each([
    ['BLOCKED', 'NOT_MET', 'BLOCKED'],
    ['NOT_MET', 'PARTIAL', 'NOT_MET'],
    ['PARTIAL', 'MET', 'PARTIAL'],
    ['MET', 'BLOCKED', 'BLOCKED']
  ])('the least-advanced of %s and %s wins: %s', (a, b, expected) => {
    const byLevel = new Map([
      ['LOCALLY_TESTED', { kit_refs: { 'FOO-01': a } }],
      ['LIVE_VERIFIED', { kit_refs: { 'FOO-01': b } }]
    ])
    expect(mergeGoverningKitRefs(byLevel)).toEqual({ 'FOO-01': expected })
  })

  it('merges independently per kit_ref — one level\'s BLOCKED does not drag down another kit_ref', () => {
    // Explicit type argument: the two kit_refs literals below have different key sets, and without
    // it TS infers a union of their exact shapes rather than each entry's kit_refs as a plain
    // Record<string, string>, which the FOO-02-less variant then fails (an inferred optional
    // `'FOO-02'?: undefined` isn't assignable to Record's `string` value type).
    const byLevel = new Map<string, { kit_refs: Record<string, string> }>([
      ['LOCALLY_TESTED', { kit_refs: { 'FOO-01': 'MET', 'FOO-02': 'MET' } }],
      ['LIVE_VERIFIED', { kit_refs: { 'FOO-01': 'BLOCKED' } }]
    ])
    expect(mergeGoverningKitRefs(byLevel)).toEqual({ 'FOO-01': 'BLOCKED', 'FOO-02': 'MET' })
  })

  it('an empty governing-records map yields no overrides', () => {
    expect(mergeGoverningKitRefs(new Map())).toEqual({})
  })
})

describe('computeRowStatus — merges citations and applies an ADR-017 evidence override', () => {
  it('returns UNMAPPED when nothing cites the row', () => {
    expect(computeRowStatus([])).toBe('UNMAPPED')
  })

  it('falls back to the owning ticket status when no evidence override exists', () => {
    const t = ticket({ status: 'IN_PROGRESS' })
    expect(computeRowStatus([{ ticket: t, citation: 'FOO-01' }])).toBe('IN_PROGRESS')
  })

  it('an evidenceByTicket entry for this exact ticket + kit_ref overrides the ticket-level status', () => {
    const t = ticket({ id: 'M2-9001', status: 'IN_PROGRESS' })
    const evidenceByTicket = new Map([['M2-9001', { 'FOO-01': 'BLOCKED' }]])
    expect(computeRowStatus([{ ticket: t, citation: 'FOO-01' }], evidenceByTicket)).toBe('BLOCKED_EXTERNAL')
  })

  it('an evidence override only applies to the exact ticket + kit_ref pair it names', () => {
    const t = ticket({ id: 'M2-9001', status: 'IN_PROGRESS' })
    const evidenceByTicket = new Map([['M2-9001', { 'OTHER-02': 'BLOCKED' }]])
    expect(computeRowStatus([{ ticket: t, citation: 'FOO-01' }], evidenceByTicket)).toBe('IN_PROGRESS')
  })

  it('an override for a different ticket citing the same kit_ref does not apply', () => {
    const t1 = ticket({ id: 'M2-9001', status: 'DONE' })
    const evidenceByTicket = new Map([['M2-9002', { 'FOO-01': 'BLOCKED' }]])
    expect(computeRowStatus([{ ticket: t1, citation: 'FOO-01' }], evidenceByTicket)).toBe('DONE')
  })

  it('merges across two citing tickets by taking the most-advanced status', () => {
    const t1 = ticket({ id: 'M2-9001', status: 'TODO' })
    const t2 = ticket({ id: 'M2-9002', status: 'DONE' })
    expect(
      computeRowStatus([
        { ticket: t1, citation: 'FOO-01' },
        { ticket: t2, citation: 'FOO-01' }
      ])
    ).toBe('DONE')
  })

  it('accepts a realistic ledger ticket (required_evidence, slices, validation_hours, due, needs_decision) without crashing', () => {
    const t = ticket({
      id: 'M2-9001',
      status: 'IN_PROGRESS',
      depends_on: [],
      required_evidence: ['LOCALLY_TESTED'],
      slices: [{ id: 'a', estimate_hours: 4 }],
      validation_hours: 1.5,
      due: '2026-10-09',
      needs_decision: ['D-3'],
      external_blocker: null,
      flag: null
    })
    expect(computeRowStatus([{ ticket: t, citation: 'FOO-01' }])).toBe('IN_PROGRESS')
  })

  it('a ticket whose evidence field is a provenance object (the real ledger shape) is simply ignored, never read', () => {
    const t = ticket({
      id: 'M2-9001',
      status: 'DONE',
      evidence: { pr: 'https://github.com/example/example/pull/1', note: 'merged on local evidence' }
    })
    expect(computeRowStatus([{ ticket: t, citation: 'FOO-01' }])).toBe('DONE')
  })
})

describe('extractDecisionIds — a table row\'s first cell only, never OD-N, PD-N or prose', () => {
  const md = `
| # | Decision |
|---|---|
| D-3 | How does X behave? |
| D-28 | May agents run tests? |

## A. Owner decisions

| OD-1 | Something already decided |

## B. Program decisions

| PD-06 | Something Opus decided |

Note: this will need to be raised as D-31 once the pattern repeats.
`

  it('extracts decision ids defined as a table row', () => {
    const ids = extractDecisionIds(md)
    expect(ids.has('D-3')).toBe(true)
    expect(ids.has('D-28')).toBe(true)
  })

  it('never matches the D-N suffix embedded inside OD-N or PD-N', () => {
    const ids = extractDecisionIds(md)
    expect(ids.has('D-1')).toBe(false)
    expect(ids.has('D-06')).toBe(false)
    expect(ids.has('D-6')).toBe(false)
  })

  it('never resolves a decision id that is only mentioned in prose', () => {
    const ids = extractDecisionIds(md)
    expect(ids.has('D-31')).toBe(false)
  })
})

describe('extractBlockerTicketRefs — ticket-bearing columns (every item) plus every bare M2-NNNN token', () => {
  it('collects every ticket referenced by a Ticket column, across multiple tables', () => {
    const md = `
## 1. Start now

| B | Owner role | Ticket |
|---|---|---|
| B-01 | Program owner | 0010 |

## 2. By role

### Program owner

| B | Ticket | Exact unblock step |
|---|---|---|
| B-02 | 0012 | Do the thing |
`
    const { refs, malformed } = extractBlockerTicketRefs(md)
    expect(refs.has('M2-0010')).toBe(true)
    expect(refs.has('M2-0012')).toBe(true)
    expect(refs.size).toBe(2)
    expect(malformed).toEqual([])
  })

  it('parses the real "NNNN: <description>" cell form used in the by-role tables', () => {
    const md = `
| B | Ticket | Exact unblock step |
|---|---|---|
| B-03 | 9007: Provision a test host | Set up a clean environment |
`
    const { refs } = extractBlockerTicketRefs(md)
    expect(refs.has('M2-9007')).toBe(true)
    expect(refs.size).toBe(1)
  })

  it('parses a described cell whose own description contains commas, without misreading them as more ticket items', () => {
    const md = `
| B | Ticket | Exact unblock step |
|---|---|---|
| B-07 | 9007: Get the one-page approval: entitlement authority (X, Y, Z), gateway policy (W), and the default route | Read the one-pager and answer |
`
    const { refs, malformed } = extractBlockerTicketRefs(md)
    expect(refs.has('M2-9007')).toBe(true)
    expect(refs.size).toBe(1)
    expect(malformed).toEqual([])
  })

  it('collects every item in a comma-separated Affected tickets cell, not just the first', () => {
    const md = `
| Decision | Class | Affected tickets |
|---|---|---|
| D-3 | escalate | 0066, 0097, 0098 |
`
    const { refs } = extractBlockerTicketRefs(md)
    expect(refs.has('M2-0066')).toBe(true)
    expect(refs.has('M2-0097')).toBe(true)
    expect(refs.has('M2-0098')).toBe(true)
    expect(refs.size).toBe(3)
  })

  it('collects a bare M2-NNNN token anywhere in the document, outside any ticket-bearing column', () => {
    const md = `
## 4. Prior blockers

| # | Issue | Notes |
|---|---|---|
| 1 | Contracts design-only | Engineering in M2-0061; decisions via D-4 |
`
    const { refs } = extractBlockerTicketRefs(md)
    expect(refs.has('M2-0061')).toBe(true)
  })

  it('reports a non-empty Ticket cell that does not parse as malformed rather than skipping it', () => {
    const md = `
| B | Ticket | Exact unblock step |
|---|---|---|
| B-01 | see above | Do the thing |
`
    const { refs, malformed } = extractBlockerTicketRefs(md)
    expect(refs.size).toBe(0)
    expect(malformed).toEqual(['see above'])
  })

  it('never accepts a digit run shorter or longer than four digits as a bare ticket number', () => {
    const md = `
| B | Ticket | Exact unblock step |
|---|---|---|
| B-01 | 007 | Do the thing |
`
    const { refs, malformed } = extractBlockerTicketRefs(md)
    expect(refs.size).toBe(0)
    expect(malformed).toEqual(['007'])
  })

  it('never reads a five-digit token as its first four digits, in a bare M2-NNNN mention or a cell', () => {
    const md = `
See M2-00123 for background.

| B | Ticket | Exact unblock step |
|---|---|---|
| B-01 | 00123 | Do the thing |
`
    const { refs, malformed } = extractBlockerTicketRefs(md)
    expect(refs.has('M2-0012')).toBe(false)
    expect(refs.has('M2-00123')).toBe(false)
    expect(malformed).toEqual(['00123'])
  })
})

describe('buildTraceability — mapping, coverage and fail-closed reconciliation', () => {
  function fixture(overrides = {}) {
    return {
      inventory: [row({ id: 'FOO-01', kit: 'kitA' }), row({ id: 'FOO-02', kit: 'kitA' })],
      tickets: [ticket({ id: 'M2-9001', kit_refs: ['FOO-01', 'FOO-02'], status: 'DONE' })],
      decisionIds: new Set<string>(),
      blockerTicketRefs: new Set<string>(),
      ...overrides
    }
  }

  it('passes with zero errors when every row maps to a ticket', () => {
    const result = buildTraceability(fixture())
    expect(result.errors).toEqual([])
    expect(result.rows).toHaveLength(2)
    expect(result.rows.every((r: any) => r.status === 'DONE')).toBe(true)
  })

  it('fails the check when an inventory row maps to no ticket', () => {
    const result = buildTraceability(
      fixture({ tickets: [ticket({ id: 'M2-9001', kit_refs: ['FOO-01'], status: 'DONE' })] })
    )
    expect(result.errors.some((e: any) => e.type === 'unmapped' && e.id === 'FOO-02')).toBe(true)
  })

  it('fails the check on a dangling ticket reference to an id absent from the inventory', () => {
    const result = buildTraceability(
      fixture({ tickets: [ticket({ id: 'M2-9001', kit_refs: ['FOO-01', 'FOO-02', 'GHOST-01'], status: 'DONE' })] })
    )
    expect(result.errors.some((e: any) => e.type === 'dangling-ticket-ref' && e.citation === 'GHOST-01')).toBe(true)
  })

  it('fails the check on an ambiguous, unqualified REF-* citation across two kits', () => {
    const result = buildTraceability(
      fixture({
        inventory: [row({ id: 'REF-01', kit: 'kitA' }), row({ id: 'REF-01', kit: 'kitB' })],
        tickets: [ticket({ id: 'M2-9001', kit_refs: ['REF-01'], status: 'DONE' })]
      })
    )
    expect(result.errors.some((e: any) => e.type === 'ambiguous-citation' && e.citation === 'REF-01')).toBe(true)
  })

  it('a kit-qualified REF-* citation resolves both rows without ambiguity', () => {
    const result = buildTraceability(
      fixture({
        inventory: [row({ id: 'REF-01', kit: 'kitA' }), row({ id: 'REF-01', kit: 'kitB' })],
        tickets: [ticket({ id: 'M2-9001', kit_refs: ['kitA:REF-01', 'kitB:REF-01'], status: 'DONE' })]
      })
    )
    expect(result.errors).toEqual([])
    expect(result.rows).toHaveLength(2)
  })

  it('reports a program ticket id cited inside kit_refs as its own error, not a dangling reference', () => {
    const result = buildTraceability(
      fixture({ tickets: [ticket({ id: 'M2-9001', kit_refs: ['FOO-01', 'FOO-02', 'M2-0042'], status: 'DONE' })] })
    )
    expect(
      result.errors.some((e: any) => e.type === 'ticket-ref-in-kit-refs' && e.citation === 'M2-0042' && e.ticketId === 'M2-9001')
    ).toBe(true)
    expect(result.errors.some((e: any) => e.type === 'dangling-ticket-ref' && e.citation === 'M2-0042')).toBe(false)
  })

  it('reports a ledger ticket id that does not match M2-\\d{4} as malformed', () => {
    const result = buildTraceability(
      fixture({ tickets: [ticket({ id: 'M2-42', kit_refs: ['FOO-01', 'FOO-02'], status: 'DONE' })] })
    )
    expect(result.errors.some((e: any) => e.type === 'malformed-ticket-id' && e.ticketId === 'M2-42')).toBe(true)
  })

  it('fails the check when a needs_decision id has no entry in DECISIONS.md', () => {
    const result = buildTraceability(
      fixture({ tickets: [ticket({ id: 'M2-9001', kit_refs: ['FOO-01', 'FOO-02'], needs_decision: ['D-99'] })] })
    )
    expect(result.errors.some((e: any) => e.type === 'unresolved-decision' && e.decisionId === 'D-99')).toBe(true)
  })

  it('passes when the needs_decision id is registered in DECISIONS.md', () => {
    const result = buildTraceability(
      fixture({
        tickets: [ticket({ id: 'M2-9001', kit_refs: ['FOO-01', 'FOO-02'], needs_decision: ['D-3'] })],
        decisionIds: new Set(['D-3'])
      })
    )
    expect(result.errors).toEqual([])
  })

  it('fails the check when a BLOCKERS.md row cites a ticket the ledger does not have', () => {
    const result = buildTraceability(fixture({ blockerTicketRefs: new Set(['M2-9001', 'M2-9999']) }))
    expect(result.errors.some((e: any) => e.type === 'dangling-blocker-ref' && e.ticketId === 'M2-9999')).toBe(true)
  })

  it('passes when every BLOCKERS.md row cites a ticket that exists', () => {
    const result = buildTraceability(fixture({ blockerTicketRefs: new Set(['M2-9001']) }))
    expect(result.errors).toEqual([])
  })

  it('fails the check on a BLOCKERS.md cell that could not be parsed as a ticket reference', () => {
    const result = buildTraceability(fixture({ malformedBlockerRefs: ['see above'] }))
    expect(result.errors.some((e: any) => e.type === 'malformed-blocker-ticket-ref' && e.cell === 'see above')).toBe(true)
  })

  it('a row cited only by a CANCELLED ticket counts as unmapped, though the ticket still appears in its tickets list', () => {
    const result = buildTraceability(
      fixture({
        tickets: [ticket({ id: 'M2-9001', kit_refs: ['FOO-01', 'FOO-02'], status: 'CANCELLED', reason: 'superseded' })]
      })
    )
    expect(result.errors.some((e: any) => e.type === 'unmapped' && e.id === 'FOO-01')).toBe(true)
    const foo01 = result.rows.find((r: any) => r.id === 'FOO-01')
    expect(foo01?.status).toBe('UNMAPPED')
    expect(foo01?.tickets).toEqual(['M2-9001'])
  })

  it('a row cited by both a CANCELLED ticket and a live one counts as mapped, from the live ticket alone', () => {
    const result = buildTraceability(
      fixture({
        tickets: [
          ticket({ id: 'M2-9001', kit_refs: ['FOO-01'], status: 'CANCELLED', reason: 'superseded' }),
          ticket({ id: 'M2-9002', kit_refs: ['FOO-01', 'FOO-02'], status: 'IN_PROGRESS' })
        ]
      })
    )
    expect(result.errors.some((e: any) => e.type === 'unmapped')).toBe(false)
    const foo01 = result.rows.find((r: any) => r.id === 'FOO-01')
    expect(foo01?.status).toBe('IN_PROGRESS')
    expect(foo01?.tickets.sort()).toEqual(['M2-9001', 'M2-9002'])
  })

  it('computes a per-ID status column from an ADR-017 evidenceByTicket override, defaulting unmapped rows to UNMAPPED', () => {
    const result = buildTraceability(
      fixture({
        tickets: [ticket({ id: 'M2-9001', kit_refs: ['FOO-01'], status: 'IN_PROGRESS' })],
        evidenceByTicket: new Map([['M2-9001', { 'FOO-01': 'BLOCKED' }]])
      })
    )
    const foo01 = result.rows.find((r: any) => r.id === 'FOO-01')
    const foo02 = result.rows.find((r: any) => r.id === 'FOO-02')
    expect(foo01?.status).toBe('BLOCKED_EXTERNAL')
    expect(foo02?.status).toBe('UNMAPPED')
  })
})

describe('rendering — structural, not a source-text snapshot', () => {
  const result = buildTraceability({
    inventory: [
      row({ id: 'FOO-01', kit: 'kitA', sources: ['plan/registry.json#foo'] }),
      row({ id: 'FOO-02', kit: 'kitA' })
    ],
    tickets: [ticket({ id: 'M2-9001', kit_refs: ['FOO-01'], status: 'DONE' })],
    decisionIds: new Set<string>(),
    blockerTicketRefs: new Set<string>()
  })

  it('renderMarkdown emits one row per inventory row with an id, kit and status column', () => {
    const md = renderMarkdown(result)
    expect(md).toContain('FOO-01')
    expect(md).toContain('kitA')
    expect(md).toContain('DONE')
  })

  it('renderMarkdown escapes a pipe in a title so it cannot corrupt the table', () => {
    const withPipe = buildTraceability({
      inventory: [row({ id: 'FOO-01', kit: 'kitA', title: 'A | B' })],
      tickets: [ticket({ id: 'M2-9001', kit_refs: ['FOO-01'], status: 'DONE' })],
      decisionIds: new Set<string>(),
      blockerTicketRefs: new Set<string>()
    })
    expect(renderMarkdown(withPipe)).toContain('A \\| B')
  })

  it('renderMarkdown\'s summary line reports row and unique-id coverage counts, not only totals', () => {
    const md = renderMarkdown(result)
    expect(md).toContain('2 row(s) (1 mapped)')
    expect(md).toContain('2 unique id(s) (1 mapped)')
    expect(md).toContain('0 error(s)')
  })

  it('renderJson emits every inventory row field unchanged (byte-for-byte), plus tickets and status', () => {
    const json = renderJson(result)
    expect(json.rows).toHaveLength(2)
    const foo01 = json.rows.find((r: any) => r.id === 'FOO-01')
    expect(foo01).toMatchObject({
      id: 'FOO-01',
      kit: 'kitA',
      source_file: 'plan/registry.json',
      source_ref: 'foo[0]',
      parent_task: '',
      sources: ['plan/registry.json#foo'],
      tickets: ['M2-9001'],
      status: 'DONE'
    })
  })

  it('renderJson\'s summary reports rows, rows_mapped, unique_ids, unique_ids_mapped and errorCount', () => {
    const json = renderJson(result)
    expect(json.summary).toEqual({ rows: 2, rows_mapped: 1, unique_ids: 2, unique_ids_mapped: 1, errorCount: 0 })
  })
})

describe('main() — the CLI contract', () => {
  let dir: string
  const EXIT = new Error('trace gate exit')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'build-traceability-'))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw EXIT
    })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  function writeFixture({ tickets, inventory, decisions = '', blockers = '' }: { tickets: unknown[]; inventory: unknown[]; decisions?: string; blockers?: string }) {
    writeFileSync(join(dir, 'tickets.json'), JSON.stringify({ tickets }), 'utf8')
    writeFileSync(join(dir, 'inventory.json'), JSON.stringify(inventory), 'utf8')
    writeFileSync(join(dir, 'DECISIONS.md'), decisions, 'utf8')
    writeFileSync(join(dir, 'BLOCKERS.md'), blockers, 'utf8')
  }

  function argv(extra: string[] = []) {
    return [
      '--tickets', join(dir, 'tickets.json'),
      '--inventory', join(dir, 'inventory.json'),
      '--decisions', join(dir, 'DECISIONS.md'),
      '--blockers', join(dir, 'BLOCKERS.md'),
      ...extra
    ]
  }

  it('exits 0 and prints OK when everything maps cleanly', async () => {
    writeFixture({ tickets: [ticket({ id: 'M2-9001', kit_refs: ['FOO-01'], status: 'DONE' })], inventory: [row({ id: 'FOO-01', kit: 'kitA' })] })
    await main(argv(['--check']))
    expect(process.exit).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[trace] OK'))
  })

  it('exits 1 and names the unmapped id when a row has no citing ticket', async () => {
    writeFixture({ tickets: [ticket({ id: 'M2-9001', kit_refs: [], status: 'DONE' })], inventory: [row({ id: 'FOO-01', kit: 'kitA' })] })
    await expect(main(argv(['--check']))).rejects.toThrow(EXIT)
    expect(process.exit).toHaveBeenCalledWith(1)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('FOO-01'))
  })

  it('writes TRACEABILITY.md and traceability.json when not in --check mode', async () => {
    writeFixture({ tickets: [ticket({ id: 'M2-9001', kit_refs: ['FOO-01'], status: 'DONE' })], inventory: [row({ id: 'FOO-01', kit: 'kitA' })] })
    const outMd = join(dir, 'TRACEABILITY.md')
    const outJson = join(dir, 'traceability.json')
    await main(argv(['--out-md', outMd, '--out-json', outJson]))
    expect(process.exit).not.toHaveBeenCalled()
    expect(readFileSync(outMd, 'utf8')).toContain('FOO-01')
    expect(JSON.parse(readFileSync(outJson, 'utf8')).rows).toHaveLength(1)
  })

  it('creates the output directory for the json/markdown files if it does not exist yet', async () => {
    writeFixture({ tickets: [ticket({ id: 'M2-9001', kit_refs: ['FOO-01'], status: 'DONE' })], inventory: [row({ id: 'FOO-01', kit: 'kitA' })] })
    const outMd = join(dir, 'nested', 'deeper', 'TRACEABILITY.md')
    const outJson = join(dir, 'nested', 'ledger', 'traceability.json')
    await main(argv(['--out-md', outMd, '--out-json', outJson]))
    expect(readFileSync(outMd, 'utf8')).toContain('FOO-01')
  })

  it('--check never writes, even when --out-md/--out-json are also given and the result is clean', async () => {
    writeFixture({ tickets: [ticket({ id: 'M2-9001', kit_refs: ['FOO-01'], status: 'DONE' })], inventory: [row({ id: 'FOO-01', kit: 'kitA' })] })
    const outMd = join(dir, 'TRACEABILITY.md')
    const outJson = join(dir, 'traceability.json')
    await main(argv(['--check', '--out-md', outMd, '--out-json', outJson]))
    expect(process.exit).not.toHaveBeenCalled()
    expect(() => readFileSync(outMd, 'utf8')).toThrow()
    expect(() => readFileSync(outJson, 'utf8')).toThrow()
  })

  it('exits 2 with a usage error naming every missing required argument (the ticket\'s own verification command)', async () => {
    await expect(main(['--check'])).rejects.toThrow(EXIT)
    expect(process.exit).toHaveBeenCalledWith(2)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('--tickets'))
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('--inventory'))
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('--decisions'))
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('--blockers'))
  })

  it('exits 2 with a usage error on an unrecognized flag', async () => {
    await expect(main(argv(['--check', '--nonsense']))).rejects.toThrow(EXIT)
    expect(process.exit).toHaveBeenCalledWith(2)
  })

  it('exits 2 with a usage error when neither --check nor both --out-md/--out-json are given', async () => {
    writeFixture({ tickets: [ticket({ id: 'M2-9001', kit_refs: ['FOO-01'], status: 'DONE' })], inventory: [row({ id: 'FOO-01', kit: 'kitA' })] })
    await expect(main(argv())).rejects.toThrow(EXIT)
    expect(process.exit).toHaveBeenCalledWith(2)
  })

  it('exits 2 with a usage error when only one of --out-md/--out-json is given, with no --check', async () => {
    writeFixture({ tickets: [ticket({ id: 'M2-9001', kit_refs: ['FOO-01'], status: 'DONE' })], inventory: [row({ id: 'FOO-01', kit: 'kitA' })] })
    await expect(main(argv(['--out-md', join(dir, 'TRACEABILITY.md')]))).rejects.toThrow(EXIT)
    expect(process.exit).toHaveBeenCalledWith(2)
  })

  it('rejects with an actionable error when --evidence is given but M2-0002\'s record store reader is not present', async () => {
    writeFixture({ tickets: [ticket({ id: 'M2-9001', kit_refs: ['FOO-01'], status: 'DONE' })], inventory: [row({ id: 'FOO-01', kit: 'kitA' })] })
    await expect(main(argv(['--check', '--evidence', join(dir, 'records')]))).rejects.toThrow()
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('record.mjs'))
  })
})
