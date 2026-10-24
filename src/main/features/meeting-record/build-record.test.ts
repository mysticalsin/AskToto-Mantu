import { describe, expect, it } from 'vitest'
import { ALPHA } from '../../__fixtures__/golden-meetings'
import { parseRecapMarkdown } from '../../transcripts-recap'
import { buildMeetingRecord, emptyRecordEdits } from './build-record'
import { LUMEN_LINES, LUMEN_RECAP } from './__fixtures__/synthetic-meetings'

const build = (edits = emptyRecordEdits(), lines = LUMEN_LINES, recap = LUMEN_RECAP) =>
  buildMeetingRecord(recap, lines, edits, 0)
const action = (r: ReturnType<typeof build>, needle: string) => r.items.find((i) => i.text.includes(needle))!

describe('buildMeetingRecord', () => {
  it('splits decisions, open questions and actions into separate kinds', () => {
    const r = build()
    expect(r.status).toBe('ok')
    expect(r.items.filter((i) => i.kind === 'decision')).toHaveLength(1)
    expect(r.items.filter((i) => i.kind === 'question')).toHaveLength(1)
    expect(r.items.filter((i) => i.kind === 'action')).toHaveLength(3)
    expect(decisionCitation(r)).toMatchObject({ fromLine: 1, toLine: 1, fromT: 2000 })
  })

  it('ids are stable across rebuilds', () => {
    expect(build().items.map((i) => i.id)).toEqual(build().items.map((i) => i.id))
    expect(new Set(build().items.map((i) => i.id)).size).toBe(5)
  })

  it('drops an owner the cited range does not mention', () => {
    const jordan = action(build(), 'training room')
    expect(jordan.owner).toBeNull()
  })

  it('keeps an owner named in the cited range or line name', () => {
    const r = build()
    expect(action(r, 'vendor contract').owner).toBe('Alex')
    expect(action(r, 'pilot invite')).toMatchObject({ owner: 'Sam', dueText: 'Friday' })
  })

  it('uncited action has null owner and due', () => {
    const r = build(emptyRecordEdits(), [LUMEN_LINES[0]])
    for (const a of r.items.filter((i) => i.kind === 'action')) {
      expect(a).toMatchObject({ citation: null, owner: null, dueText: null })
    }
  })

  it('summary-only meeting marks summaryOnly and cites nothing', () => {
    const r = build(emptyRecordEdits(), [])
    expect(r.summaryOnly).toBe(true)
    expect(r.items.every((i) => i.citation === null)).toBe(true)
  })

  it('corrected transcript line moves the citation', () => {
    const corrected = LUMEN_LINES.map((l, i) => (i === 1 ? { ...l, text: 'Moving on to the next topic please.' } : l))
    const moved = [...corrected.slice(0, 4), { ...LUMEN_LINES[1], t: 6000 }]
    expect(decisionCitation(build(emptyRecordEdits(), corrected))).toBeNull()
    expect(decisionCitation(build(emptyRecordEdits(), moved))).toMatchObject({ fromLine: 4, fromT: 6000 })
  })

  it('user edit overrides text/owner and recomputes citation', () => {
    const base = build()
    const target = action(base, 'training room')
    const edits = emptyRecordEdits()
    edits.edits[target.id] = {
      op: 'set',
      text: 'Send the pilot invite to the vendor',
      owner: 'Jordan',
      at: '2026-10-24T00:00:00.000Z'
    }
    const edited = build(edits).items.find((i) => i.id === target.id)!
    expect(edited).toMatchObject({ source: 'user', owner: 'Jordan', text: 'Send the pilot invite to the vendor' })
    expect(edited.citation).toMatchObject({ toLine: 3 })
  })

  it('delete hides item', () => {
    const base = build()
    const edits = emptyRecordEdits()
    edits.edits[base.items[0].id] = { op: 'delete', at: 'x' }
    expect(build(edits).items).toHaveLength(base.items.length - 1)
  })

  it('added item appears with source user', () => {
    const edits = emptyRecordEdits()
    edits.added.push({
      id: 'user:1',
      kind: 'decision',
      text: 'Launch Project Lumen soon',
      owner: null,
      dueText: null,
      at: 'x'
    })
    const added = build(edits).items.find((i) => i.id === 'user:1')!
    expect(added.source).toBe('user')
    expect(added.citation).toMatchObject({ fromLine: 1 })
  })

  it('edit to vanished id counts as orphaned', () => {
    const edits = emptyRecordEdits()
    edits.edits['decision:gone'] = { op: 'delete', at: 'x' }
    const r = build(edits)
    expect(r.orphanedEdits).toBe(1)
    expect(r.items).toHaveLength(5)
  })

  it('no recap and no added items reports no-recap', () => {
    expect(build(emptyRecordEdits(), LUMEN_LINES, '').status).toBe('no-recap')
  })

  it('RecapExport from parseRecapMarkdown is unchanged for golden fixtures', () => {
    const { markdown, ...rest } = parseRecapMarkdown(ALPHA.meeting.recap ?? '')
    expect(markdown).toBe(ALPHA.meeting.recap)
    expect(rest).toEqual(ALPHA.expectedExport)
  })
})

function decisionCitation(r: ReturnType<typeof build>) {
  return r.items.find((i) => i.kind === 'decision')!.citation
}
