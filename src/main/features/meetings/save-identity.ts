import { basename, dirname } from 'node:path'
import type { SaveMeeting, Settings } from '@shared/ipc'
import { withMeetingMutation } from '../../infra/storage/meeting-mutation-lane'
import { storageAt } from '../../infra/storage/meetings-storage'
import type { TranscriptSaveReceipt, TranscriptSaveReceiptStore } from '../../transcript-save-receipts'
import { isEncryptedBytes, saveMeeting, writeSaved } from '../../transcripts'
import { composeSavedMeeting } from './compose-saved-meeting'
import { getMeetingSpeechReadLimitBytes } from './meeting-speech'

/** Receipt stages that credit the user's tiles: a rewritten save must never credit the same meeting twice. */
const CREDIT_STAGES = ['summary-credit', 'time-saved-credit'] as const

/**
 * Replace the content of an ALREADY-saved meeting with a newer payload for the same meeting. One meeting identity is
 * one file: the filename and the index row stay as they are, only the document is rebuilt. Encryption is kept as
 * found, not read from the live toggle. Returns 'missing' when the file is gone, so the caller may create it afresh.
 */
export async function rewriteSavedMeeting(
  settings: Settings,
  path: string,
  m: SaveMeeting,
  beforeReplace?: () => void
): Promise<'rewritten' | 'missing'> {
  const folder = dirname(path)
  return withMeetingMutation(path, async () => {
    const maxBytes = getMeetingSpeechReadLimitBytes()
    const read = await storageAt(folder).read(basename(path), { ...(maxBytes ? { maxBytes } : {}) })
    if (read.status === 'missing') return 'missing'
    if (read.status !== 'ok') throw new Error('Could not read the saved meeting.')
    const { document } = await composeSavedMeeting(settings, m)
    await writeSaved(path, document, isEncryptedBytes(read.bytes), beforeReplace)
    return 'rewritten'
  })
}

/**
 * One meeting identity is one saved file. The first save of a meeting creates it. A later payload for the same meeting
 * (the renderer re-created it with a different fingerprint after a first save whose later stage failed) rewrites that
 * file instead of creating a `-2` copy, and the receipt inherits the credit stages the first save already recorded.
 * `owner` is absent for a legacy save with no live start instant: there is no identity to match, so it creates.
 */
export async function writeMeetingOnce(
  receipt: TranscriptSaveReceipt,
  settings: Settings,
  meeting: SaveMeeting,
  receipts: Pick<TranscriptSaveReceiptStore, 'durablePathsForMeeting'>,
  owner: { authGeneration: number } | undefined
): Promise<string> {
  const prior = owner ? receipts.durablePathsForMeeting(meeting.startedAt, owner.authGeneration)[0] : undefined
  if (prior && (await rewriteSavedMeeting(prior.settings, prior.path, meeting)) === 'rewritten') {
    for (const stage of CREDIT_STAGES) if (prior.completed?.has(stage)) receipt.completed.add(stage)
    return prior.path
  }
  return saveMeeting(settings, meeting)
}
