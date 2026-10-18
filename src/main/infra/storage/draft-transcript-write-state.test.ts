import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { draftFilename, snapshotDraftWrites, trackDraftWrite } from './draft-transcript-write-state'

describe('draft transcript write state', () => {
  it('retains the caller timestamp and millisecond filename identity', () => {
    expect(draftFilename(1_700_000_000_007, '2026-10-18_134501')).toBe(
      '.autosave-draft-2026-10-18_134501-007.md'
    )
    expect(draftFilename(1_700_000_000_507, '2026-10-18_134501')).toBe(
      '.autosave-draft-2026-10-18_134501-507.md'
    )
  })

  it('returns undefined synchronously when no write was admitted for the exact path', () => {
    expect(snapshotDraftWrites('synthetic-unregistered-draft.md')).toBeUndefined()
  })

  it('captures only already-admitted writes at the resolved path and settles them independently', async () => {
    const file = 'synthetic-drafts/meeting.md'
    const finishFirst = trackDraftWrite(file)
    const first = snapshotDraftWrites(resolve(file))
    const finishLater = trackDraftWrite(file)
    const finishOther = trackDraftWrite('synthetic-drafts/other-meeting.md')
    try {
      expect(first).toHaveLength(1)
      expect(snapshotDraftWrites(file)).toHaveLength(2)
      expect(snapshotDraftWrites('synthetic-drafts/other-meeting.md')).toHaveLength(1)
      expect(first).toHaveLength(1)
      finishFirst()
      if (!first) throw new Error('Expected the admitted write snapshot')
      await Promise.all(first)
      expect(snapshotDraftWrites(file)).toHaveLength(1)
      finishLater()
      expect(snapshotDraftWrites(file)).toBeUndefined()
      expect(snapshotDraftWrites('synthetic-drafts/other-meeting.md')).toHaveLength(1)
    } finally {
      finishFirst()
      finishLater()
      finishOther()
    }
  })

  it('permits later writes after the prior snapshot has settled', async () => {
    const file = 'synthetic-drafts/later-meeting.md'
    const finish = trackDraftWrite(file)
    const pending = snapshotDraftWrites(file)
    finish()
    if (!pending) throw new Error('Expected the admitted write snapshot')
    await Promise.all(pending)
    expect(snapshotDraftWrites(file)).toBeUndefined()
    const finishLater = trackDraftWrite(file)
    try {
      expect(snapshotDraftWrites(file)).toHaveLength(1)
    } finally {
      finishLater()
    }
    expect(snapshotDraftWrites(file)).toBeUndefined()
  })
})
