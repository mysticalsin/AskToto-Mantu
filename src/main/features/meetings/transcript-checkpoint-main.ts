import { basename, dirname } from 'node:path'
import type { TranscriptRevision } from '@shared/contracts/speech/transcript-revision'
import {
  isDraftMeetingFinalized,
  knownDraftPathsForMeeting,
  serializeDraftWrite,
  trackDraftWrite
} from '../../infra/storage/draft-transcript-write-state'
import { storageAt } from '../../infra/storage/meetings-storage'
import { decodeSavedMeetingAsync, isEncryptedBytes, writeSaved } from '../../transcripts'
import { getMeetingSpeechReadLimitBytes } from './meeting-speech'
import { applyRevisionCheckpoint } from './transcript-checkpoint'
import type { CheckpointWriteOutcome, CheckpointWriter } from './transcript-revision-store'

/** Rewrites one draft's frontmatter in place, keeping the file's own at-rest encryption. A checkpoint never
 *  creates a file: a missing one is 'absent' (drafts off, summary-only, or not yet autosaved). */
async function stampFile(path: string, rev: TranscriptRevision): Promise<CheckpointWriteOutcome> {
  const maxBytes = getMeetingSpeechReadLimitBytes()
  const read = await storageAt(dirname(path)).read(basename(path), maxBytes ? { maxBytes } : {})
  if (read.status === 'missing') return 'absent'
  if (read.status !== 'ok') return 'failed'
  const decoded = await decodeSavedMeetingAsync(read.bytes, false, path)
  if (!decoded.ok) return 'failed'
  const next = applyRevisionCheckpoint(decoded.text, rev)
  if (next === null) return 'failed'
  if (next !== decoded.text) await writeSaved(path, next, isEncryptedBytes(read.bytes))
  return 'written'
}

async function checkpointDrafts(meetingStartedAt: number, rev: TranscriptRevision): Promise<CheckpointWriteOutcome> {
  if (isDraftMeetingFinalized(meetingStartedAt)) return 'sealed'
  const paths = knownDraftPathsForMeeting(meetingStartedAt)
  if (paths.length === 0) return 'absent'
  // Admit every path before the first await, like an autosave, so completed-save cleanup joins this rewrite.
  const finishes: Array<() => void> = []
  for (const path of paths) {
    const finish = trackDraftWrite(path, meetingStartedAt)
    if (!finish) {
      for (const done of finishes) done()
      return 'sealed'
    }
    finishes.push(finish)
  }
  try {
    const outcomes = await Promise.all(
      paths.map((path) =>
        serializeDraftWrite(path, () => stampFile(path, rev)).catch((): CheckpointWriteOutcome => 'failed')
      )
    )
    if (outcomes.includes('failed')) return 'failed'
    return outcomes.includes('written') ? 'written' : 'absent'
  } finally {
    for (const done of finishes) done()
  }
}

/** The production checkpoint writer: the meeting's autosave drafts, in every folder it used. */
export const writeTranscriptCheckpoint: CheckpointWriter = async (meetingStartedAt, rev) => {
  try {
    return await checkpointDrafts(meetingStartedAt, rev)
  } catch {
    return 'failed'
  }
}
