import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { MeetingRecord, RecordItem } from '@shared/meeting-record'
import { MeetingRecordList, RecordItemEditor, recordEditKey, setOp } from './MeetingRecordPanel'

const item = (over: Partial<RecordItem> = {}): RecordItem => ({
  id: 'decision:a',
  kind: 'decision',
  text: 'Launch Project Lumen in a staged rollout',
  owner: null,
  dueText: null,
  citation: { fromLine: 11, toLine: 13, fromT: 0, toT: 1, utteranceIds: [] },
  source: 'recap',
  ...over
})
const record = (items: RecordItem[]): MeetingRecord => ({
  status: 'ok',
  items,
  summaryOnly: false,
  orphanedEdits: 0,
  startedAt: 0
})
const noop = (): void => {}
const html = (r: MeetingRecord): string =>
  renderToStaticMarkup(<MeetingRecordList record={r} onJump={noop} onSet={noop} onDelete={noop} onAdd={noop} />)

describe('MeetingRecordPanel', () => {
  it('renders three sections with citation chip', () => {
    const out = html(record([item(), item({ id: 'question:b', kind: 'question', text: 'Who owns the drill?' })]))
    expect(out).toContain('Decisions')
    expect(out).toContain('Open questions')
    expect(out).toContain('Actions')
    expect(out).toContain('lines 12–14')
    expect(out).toContain('Launch Project Lumen')
  })

  it('uncited shows "No transcript source"', () => {
    expect(html(record([item({ citation: null })]))).toContain('No transcript source')
  })

  it('renders nothing when unavailable', () => {
    expect(html({ ...record([]), status: 'unavailable' })).toBe('')
  })

  it('edit calls bridge with set op carrying only the changed fields', () => {
    const action = item({ id: 'action:c', kind: 'action', text: 'Book room', owner: 'Alex' })
    expect(setOp('m.md', action, { text: 'Book room', owner: 'Sam', dueText: '' })).toEqual({
      file: 'm.md',
      op: 'set',
      id: 'action:c',
      owner: 'Sam'
    })
  })

  it('names every row action with its item (G91)', () => {
    const long = 'Launch Project Lumen in a staged rollout across every region we operate in this year'
    const out = html(record([item({ text: long })]))
    expect(out).toContain(`aria-label="Edit: ${long.slice(0, 59)}…"`)
    expect(out).toContain(`aria-label="Delete: ${long.slice(0, 59)}…"`)
    expect(out).toContain('aria-label="Add decision"')
    expect(out).toContain('aria-label="Add open question"')
    expect(out).toContain('aria-label="Add action"')
  })

  it('section titles are headings that label their lists (G91)', () => {
    const out = html(record([item()]))
    const heading = out.match(/<h3 id="([^"]+)"[^>]*>Decisions<\/h3>/)
    expect(heading).not.toBeNull()
    expect(out).toContain(`aria-labelledby="${heading?.[1]}"`)
  })

  it('recordEditKey: Escape cancels, Enter saves single-line, Cmd+Enter saves multiline, IME composition is ignored (G91)', () => {
    expect(recordEditKey({ key: 'Escape' }, false)).toBe('cancel')
    expect(recordEditKey({ key: 'Escape' }, true)).toBe('cancel')
    expect(recordEditKey({ key: 'Enter' }, false)).toBe('save')
    expect(recordEditKey({ key: 'Enter', shiftKey: true }, false)).toBeNull()
    expect(recordEditKey({ key: 'Enter' }, true)).toBeNull()
    expect(recordEditKey({ key: 'Enter', metaKey: true }, true)).toBe('save')
    expect(recordEditKey({ key: 'Enter', ctrlKey: true }, true)).toBe('save')
    expect(recordEditKey({ key: 'Enter', isComposing: true }, false)).toBeNull()
    expect(recordEditKey({ key: 'Escape', isComposing: true }, false)).toBeNull()
    expect(recordEditKey({ key: 'a' }, false)).toBeNull()
  })

  it('edit form autofocuses the text field and names its buttons (G91)', () => {
    const out = renderToStaticMarkup(
      <RecordItemEditor
        item={item()}
        draft={{ text: 'x', owner: '', dueText: '' }}
        onDraft={noop}
        onSave={noop}
        onCancel={noop}
      />
    )
    expect(out).toContain('aria-label="Save edit"')
    expect(out).toContain('aria-label="Cancel edit"')
  })
})
