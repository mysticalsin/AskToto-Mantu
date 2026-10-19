import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import {
  draftFilename,
  finalizeDraftMeeting,
  finalizeDraftWrites,
  isDraftMeetingFinalized,
  snapshotDraftWrites,
  trackDraftWrite
} from './draft-transcript-write-state'

function mustTrack(file: string, meetingStartedAt?: number): () => void {
  const finish = trackDraftWrite(file, meetingStartedAt)
  if (!finish) throw new Error('Expected the draft path to remain open')
  return finish
}

describe('draft transcript write state', () => {
  it('retains the caller timestamp and millisecond filename identity', () => {
    expect(draftFilename(1_700_000_000_007, '2026-10-18_134501')).toBe('.autosave-draft-2026-10-18_134501-007.md')
    expect(draftFilename(1_700_000_000_507, '2026-10-18_134501')).toBe('.autosave-draft-2026-10-18_134501-507.md')
  })

  it('returns undefined synchronously when no write was admitted for the exact path', () => {
    expect(snapshotDraftWrites('synthetic-unregistered-draft.md')).toBeUndefined()
  })

  it('captures only already-admitted writes at the resolved path and settles them independently', async () => {
    const file = 'synthetic-drafts/meeting.md'
    const finishFirst = mustTrack(file)
    const first = snapshotDraftWrites(resolve(file))
    const finishLater = mustTrack(file)
    const finishOther = mustTrack('synthetic-drafts/other-meeting.md')
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
    const finish = mustTrack(file)
    const pending = snapshotDraftWrites(file)
    finish()
    if (!pending) throw new Error('Expected the admitted write snapshot')
    await Promise.all(pending)
    expect(snapshotDraftWrites(file)).toBeUndefined()
    const finishLater = mustTrack(file)
    try {
      expect(snapshotDraftWrites(file)).toHaveLength(1)
    } finally {
      finishLater()
    }
    expect(snapshotDraftWrites(file)).toBeUndefined()
  })

  it('seals the exact path synchronously and waits for earlier writes without sealing another path', async () => {
    const file = 'synthetic-drafts/finalized-meeting.md'
    const finish = mustTrack(file)
    let cleanupSettled = false
    const cleanup = finalizeDraftWrites(file).then(() => { cleanupSettled = true })
    expect(trackDraftWrite(file)).toBeNull()
    const finishOther = mustTrack('synthetic-drafts/next-meeting.md')
    try {
      expect(cleanupSettled).toBe(false)
      finish()
      await cleanup
      expect(cleanupSettled).toBe(true)
      expect(snapshotDraftWrites(file)).toBeUndefined()
      expect(snapshotDraftWrites('synthetic-drafts/next-meeting.md')).toHaveLength(1)
    } finally {
      finish()
      finishOther()
    }
  })

  it('seals a meeting identity across every observed folder before joining admitted writes', async () => {
    const startedAt = 1_800_000_000_123
    const folderAPath = 'synthetic-drafts/a/meeting.md'
    const folderBPath = 'synthetic-drafts/b/meeting.md'
    const finishA = mustTrack(folderAPath, startedAt)
    const finishB = mustTrack(folderBPath, startedAt)
    let finalized = false
    const finalization = finalizeDraftMeeting(startedAt, ['synthetic-drafts/b/final.md']).then((files) => {
      finalized = true
      return files
    })
    expect(isDraftMeetingFinalized(startedAt)).toBe(true)
    expect(trackDraftWrite('synthetic-drafts/c/late.md', startedAt)).toBeNull()
    const otherMeetingFinish = mustTrack('synthetic-drafts/c/other.md', startedAt + 1)
    try {
      expect(finalized).toBe(false)
      finishA()
      finishB()
      const files = await finalization
      expect(new Set(files)).toEqual(new Set([resolve(folderAPath), resolve(folderBPath), resolve('synthetic-drafts/b/final.md')]))
      expect(finalized).toBe(true)
      expect(snapshotDraftWrites(folderAPath)).toBeUndefined()
      expect(snapshotDraftWrites(folderBPath)).toBeUndefined()
      expect(snapshotDraftWrites('synthetic-drafts/c/other.md')).toHaveLength(1)
    } finally {
      finishA()
      finishB()
      otherMeetingFinish()
    }
  })
})
