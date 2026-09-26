import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  KIT_REQUIREMENT_ID_RE,
  PROGRAM_TICKET_ID_RE,
  buildInventoryIndex,
  buildTraceability,
  classifyM2Id,
  computeRowStatus,
  extractBlockerTicketRefs,
  extractDecisionIds,
  main,
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
    evidence: [],
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
    expect(result.row?.kit).toBe('kitA')
  })

  it('refuses an unqualified citation of an id shared by two kits', () => {
    const result = resolveCitation('REF-01', index)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('ambiguous')
  })

  it('resolves a kit-qualified citation to the exact row', () => {
    const a = resolveCitation('kitA:REF-01', index)
    const b = resolveCitation('kitB:REF-01', index)
    expect(a.ok && a.row?.title).toBe('kitA source')
    expect(b.ok && b.row?.title).toBe('kitB source')
  })

  it('reports an unknown citation that matches no row in any kit', () => {
    const result = resolveCitation('NOPE-99', index)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('unknown')
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
})

describe('computeRowStatus — per-kit_ref evidence overrides, accepts DEFERRED', () => {
  it('returns UNMAPPED when nothing cites the row', () => {
    expect(computeRowStatus(row(), [])).toBe('UNMAPPED')
  })

  it('falls back to the owning ticket status when no evidence override exists', () => {
    const t = ticket({ status: 'IN_PROGRESS' })
    expect(computeRowStatus(row({ id: 'FOO-01' }), [{ ticket: t, citation: 'FOO-01' }])).toBe('IN_PROGRESS')
  })

  it('an evidence record status for this exact kit_ref overrides the ticket-level status', () => {
    const t = ticket({
      status: 'IN_PROGRESS',
      evidence: [{ kit_ref: 'FOO-01', status: 'DONE' }]
    })
    expect(computeRowStatus(row({ id: 'FOO-01' }), [{ ticket: t, citation: 'FOO-01' }])).toBe('DONE')
  })

  it('accepts DEFERRED from an evidence record without erroring', () => {
    const t = ticket({ status: 'IN_PROGRESS', evidence: [{ kit_ref: 'FOO-01', status: 'DEFERRED' }] })
    expect(computeRowStatus(row({ id: 'FOO-01' }), [{ ticket: t, citation: 'FOO-01' }])).toBe('DEFERRED')
  })

  it('merges across two citing tickets by taking the most-advanced status', () => {
    const t1 = ticket({ id: 'M2-9001', status: 'TODO' })
    const t2 = ticket({ id: 'M2-9002', status: 'DONE' })
    expect(
      computeRowStatus(row({ id: 'FOO-01' }), [
        { ticket: t1, citation: 'FOO-01' },
        { ticket: t2, citation: 'FOO-01' }
      ])
    ).toBe('DONE')
  })

  it('an evidence override only applies to the citation it names', () => {
    const t = ticket({
      status: 'TODO',
      evidence: [{ kit_ref: 'OTHER-02', status: 'DONE' }]
    })
    expect(computeRowStatus(row({ id: 'FOO-01' }), [{ ticket: t, citation: 'FOO-01' }])).toBe('NOT_STARTED')
  })
})

describe('extractDecisionIds — bare D-N only, never OD-N or PD-N', () => {
  const md = `
| # | Decision |
|---|---|
| D-3 | How does X behave? |
| D-28 | May agents run tests? |

## A. Owner decisions

| OD-1 | Something already decided |

## B. Program decisions

| PD-06 | Something Opus decided |
`

  it('extracts bare decision ids', () => {
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
})

describe('extractBlockerTicketRefs — the Ticket column, across multiple tables', () => {
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

  it('collects ticket references from every table that has a Ticket column', () => {
    const refs = extractBlockerTicketRefs(md)
    expect(refs.has('M2-0010')).toBe(true)
    expect(refs.has('M2-0012')).toBe(true)
    expect(refs.size).toBe(2)
  })
})

describe('buildTraceability — the eight acceptance behaviors', () => {
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

  it('computes a per-ID status column derived from ticket + evidence, defaulting unmapped rows to UNMAPPED', () => {
    const result = buildTraceability(
      fixture({
        tickets: [
          ticket({
            id: 'M2-9001',
            kit_refs: ['FOO-01'],
            status: 'IN_PROGRESS',
            evidence: [{ kit_ref: 'FOO-01', status: 'ENGINEERING_COMPLETE' }]
          })
        ]
      })
    )
    const foo01 = result.rows.find((r: any) => r.id === 'FOO-01')
    const foo02 = result.rows.find((r: any) => r.id === 'FOO-02')
    expect(foo01?.status).toBe('ENGINEERING_COMPLETE')
    expect(foo02?.status).toBe('UNMAPPED')
  })
})

describe('rendering — structural, not a source-text snapshot', () => {
  const result = buildTraceability({
    inventory: [row({ id: 'FOO-01', kit: 'kitA' })],
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

  it('renderJson emits a machine-readable row per id with a summary block', () => {
    const json = renderJson(result)
    expect(json.rows).toHaveLength(1)
    expect(json.rows[0]).toMatchObject({ id: 'FOO-01', kit: 'kitA', status: 'DONE' })
    expect(json.summary.total).toBe(1)
    expect(json.summary.errorCount).toBe(0)
  })
})

describe('main() — the --check CLI contract', () => {
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

  it('exits 0 and prints OK when everything maps cleanly', () => {
    writeFixture({ tickets: [ticket({ id: 'M2-9001', kit_refs: ['FOO-01'], status: 'DONE' })], inventory: [row({ id: 'FOO-01', kit: 'kitA' })] })
    main(argv(['--check']))
    expect(process.exit).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[trace] OK'))
  })

  it('exits 1 and names the unmapped id when a row has no citing ticket', () => {
    writeFixture({ tickets: [ticket({ id: 'M2-9001', kit_refs: [], status: 'DONE' })], inventory: [row({ id: 'FOO-01', kit: 'kitA' })] })
    expect(() => main(argv(['--check']))).toThrow(EXIT)
    expect(process.exit).toHaveBeenCalledWith(1)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('FOO-01'))
  })

  it('writes TRACEABILITY.md and traceability.json when not in --check mode', () => {
    writeFixture({ tickets: [ticket({ id: 'M2-9001', kit_refs: ['FOO-01'], status: 'DONE' })], inventory: [row({ id: 'FOO-01', kit: 'kitA' })] })
    const outMd = join(dir, 'TRACEABILITY.md')
    const outJson = join(dir, 'traceability.json')
    main(argv(['--out-md', outMd, '--out-json', outJson]))
    expect(process.exit).not.toHaveBeenCalled()
    expect(readFileSync(outMd, 'utf8')).toContain('FOO-01')
    expect(JSON.parse(readFileSync(outJson, 'utf8')).rows).toHaveLength(1)
  })

  it('creates the output directory for the json/markdown files if it does not exist yet', () => {
    writeFixture({ tickets: [ticket({ id: 'M2-9001', kit_refs: ['FOO-01'], status: 'DONE' })], inventory: [row({ id: 'FOO-01', kit: 'kitA' })] })
    const outMd = join(dir, 'nested', 'deeper', 'TRACEABILITY.md')
    const outJson = join(dir, 'nested', 'ledger', 'traceability.json')
    main(argv(['--out-md', outMd, '--out-json', outJson]))
    expect(readFileSync(outMd, 'utf8')).toContain('FOO-01')
  })
})
