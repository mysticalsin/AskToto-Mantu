import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { MeetingRecord, RecordItem } from '@shared/meeting-record'
import { MeetingRecordList, setOp } from './MeetingRecordPanel'

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
})
