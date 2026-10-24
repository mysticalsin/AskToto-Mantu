import { describe, expect, it } from 'vitest'
import { sourceIdOf } from '../features/data-rights/data-export'
import { collectExtraRecords, type ExportRecordSources } from './data-rights-export-records'

const MEETING_FILE = '2026-10-24_100000-synthetic.md'

function sources(over: Partial<ExportRecordSources> = {}): ExportRecordSources {
  return {
    assistants: async () => [],
    userMemory: async () => ({ status: 'ok', items: [], tombstones: 0 }),
    dictionary: async () => ({ status: 'ok', entries: [] }),
    brainEntities: async () => [],
    ...over
  }
}

describe('data export records beyond meetings (G82)', () => {
  it('exports user memory with its origin and what a derived item came from', async () => {
    const records = await collectExtraRecords(
      sources({
        userMemory: async () => ({
          status: 'ok',
          tombstones: 3,
          items: [
            {
              id: 'a'.repeat(32),
              kind: 'preference',
              text: 'synthetic preference',
              source: 'owner-typed',
              at: 5,
              turnId: null,
              revision: 1,
              expiresAt: null,
              conversation: null
            },
            {
              id: 'b'.repeat(32),
              kind: 'project-context',
              text: 'synthetic context',
              source: 'derived',
              at: 6,
              turnId: null,
              revision: 1,
              expiresAt: 99,
              conversation: MEETING_FILE
            }
          ]
        })
      })
    )
    expect(records.map((r) => [r.store, r.origin, r.modifiedAt])).toEqual([
      ['user-memory', 'user-typed', 5],
      ['user-memory', 'derived', 6]
    ])
    expect(records[0]?.derivedFrom).toBeUndefined()
    expect(records[1]?.derivedFrom).toEqual([sourceIdOf(MEETING_FILE)])
    expect(JSON.parse(records[0]?.text ?? '{}')).toMatchObject({ kind: 'preference', text: 'synthetic preference' })
    expect(records[0]?.text).not.toContain('tombstone') // a tombstone count is not owner data
  })

  it('exports the personal dictionary as owner-typed and derived knowledge naming its meetings', async () => {
    const records = await collectExtraRecords(
      sources({
        dictionary: async () => ({
          status: 'ok',
          entries: [{ id: 'c'.repeat(32), heard: 'synthetic', preferred: 'Synthetic', count: 2, updatedAtMs: 7 }]
        }),
        brainEntities: async () => [
          {
            kind: 'person',
            slug: 'synthetic-person',
            record: { name: 'Synthetic' },
            meetingFiles: [MEETING_FILE],
            modifiedAt: 8
          }
        ]
      })
    )
    const byStore = Object.fromEntries(records.map((r) => [r.store, r]))
    expect(byStore['dictation-memory']).toMatchObject({ origin: 'user-typed', modifiedAt: 7 })
    expect(byStore.brain).toMatchObject({ origin: 'derived', derivedFrom: [sourceIdOf(MEETING_FILE)], modifiedAt: 8 })
    expect(JSON.parse(byStore.brain?.text ?? '{}')).toMatchObject({ kind: 'person', record: { name: 'Synthetic' } })
  })

  it('an unavailable or failing source is skipped and never stops the others', async () => {
    const records = await collectExtraRecords(
      sources({
        userMemory: async () => ({ status: 'unavailable', items: [], tombstones: 0 }),
        dictionary: async () => {
          throw new Error('/Users/someone/private/path')
        },
        assistants: async () => [{ assistantId: 'asst-1', name: 'N', base: 'meeting', instructions: 'I', updatedAt: 1 }]
      })
    )
    expect(records.map((r) => r.store)).toEqual(['assistants'])
  })
})
