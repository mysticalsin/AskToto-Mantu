import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: string[] = []
let editsFail = false

vi.mock('../meeting-files', () => ({
  removeMeetingFile: vi.fn(async () => void calls.push('meeting')),
  editMeetingIndex: vi.fn(async () => undefined)
}))
vi.mock('./meeting-deletion', () => ({ deleteMemoryForLocalMeeting: vi.fn(async () => undefined) }))
vi.mock('../features/meeting-record/default-deps', () => ({
  defaultRecordEditsDeps: {
    read: async () => null,
    decode: () => null,
    write: async () => undefined,
    remove: async (path: string) => {
      calls.push('edits')
      if (editsFail) throw new Error('EBUSY')
      void path
    }
  }
}))

import { deleteMeetingWithMemoryPropagation } from './delete-propagation'

describe('deleting a meeting removes its record edits (G78)', () => {
  beforeEach(() => {
    calls.length = 0
    editsFail = false
  })

  it('deleting a meeting removes its record edits', async () => {
    expect(await deleteMeetingWithMemoryPropagation('/synthetic', 'a.md')).toEqual({ ok: true })
    expect(calls).toEqual(['meeting', 'edits'])
  })

  it('edits removal failure does not fail the delete', async () => {
    editsFail = true
    expect(await deleteMeetingWithMemoryPropagation('/synthetic', 'a.md')).toEqual({ ok: true })
  })
})
