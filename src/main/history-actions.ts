/**
 * History's single-meeting actions (Open, Export copy) read the meeting through the storage gateway.
 *
 * Invariants:
 *   - The meeting file is never read synchronously: a cloud-only, locked or kernel-blocked file answers
 *     within the gateway's read deadline (5 s) while the main thread keeps running.
 *   - `safeName` is a basename already checked by safeMeetingBasename; these helpers never build a path
 *     from anything else.
 */
import { getMeetingSpeechReadLimitBytes, publicMeetingTextAsync } from './features/meetings/meeting-speech'
import { join } from 'node:path'
import { storageAt } from './infra/storage/meetings-storage'
import type { ReadOptions } from './infra/storage/gateway'
import { decodeSavedMeetingAsync, decryptMeetingToTempAsync, isEncryptedBytes } from './transcripts'

/** Shown on the History row when the gateway could not read the meeting (cloud-only, locked, slow). */
export const MEETING_NOT_READABLE_MSG =
  'Could not read the meeting file right now. If it is stored only in the cloud, make it available offline and try again.'

export type OpenTarget = { ok: true; path: string; encrypted: boolean } | { ok: false; error: string }

/** What History's "Open" hands to the OS: the meeting itself, or a decrypted temp copy when it is
 *  encrypted at rest. A missing file is handed over as-is, so the OS reports it as before. */
export async function meetingOpenTarget(
  folder: string,
  safeName: string,
  { hydrate = false, onProgress }: Pick<ReadOptions, 'hydrate' | 'onProgress'> = {}
): Promise<OpenTarget> {
  const path = join(folder, safeName)
  const gateway = storageAt(folder)
  const maxBytes = getMeetingSpeechReadLimitBytes()
  // A FIFO, socket or device is refused before any read: a plain gateway read would still open it once
  // the detector answers. Classify's other verdicts never skip the read below.
  const fileClass = (await gateway.classify([safeName])).get(safeName)
  if (fileClass && 'isRegular' in fileClass && !fileClass.isRegular)
    return { ok: false, error: MEETING_NOT_READABLE_MSG }
  let read = await gateway.read(safeName, { ...(maxBytes ? { maxBytes } : {}) })
  // The user's explicit Open hydrates this one cloud-only file (under a content permit, with progress).
  if (hydrate && (read.status === 'dataless' || read.status === 'unknown'))
    read = await gateway.read(safeName, { hydrate, onProgress, ...(maxBytes ? { maxBytes } : {}) })
  if (read.status === 'missing') return { ok: true, path, encrypted: false }
  if (read.status !== 'ok') return { ok: false, error: MEETING_NOT_READABLE_MSG }
  if (!isEncryptedBytes(read.bytes)) return { ok: true, path, encrypted: false }
  return { ok: true, path: await decryptMeetingToTempAsync(path, read.bytes), encrypted: true }
}

/** The gateway-backed readSavedFile: the meeting's decoded text, '' when it cannot be decrypted on this
 *  device. Throws an ENOENT error when the file is missing and a plain error when it cannot be read, so
 *  callers keep readSavedFile's error handling. */
export async function readSavedMeeting(folder: string, safeName: string): Promise<string> {
  const maxBytes = getMeetingSpeechReadLimitBytes()
  const read = await storageAt(folder).read(safeName, { ...(maxBytes ? { maxBytes } : {}) })
  if (read.status === 'ok') {
    const decoded = await decodeSavedMeetingAsync(read.bytes, false, join(folder, safeName))
    return publicMeetingTextAsync(decoded.ok ? decoded.text : '')
  }
  if (read.status === 'dataless' || read.status === 'unknown') throw new MeetingNotDownloadedError()
  const error = new Error(`meeting file ${read.status}`) as NodeJS.ErrnoException
  if (read.status === 'missing') error.code = 'ENOENT'
  throw error
}

export const MEETING_NOT_DOWNLOADED_MSG =
  "This meeting isn't downloaded to this device. Download it first, then export."

/** readSavedMeeting's refusal for a cloud-only meeting: Export never hydrates, so the way out is Download. */
export class MeetingNotDownloadedError extends Error {
  constructor() {
    super('meeting file not downloaded')
    this.name = 'MeetingNotDownloadedError'
  }
}

/** The sentence History shows when exporting a meeting copy failed, without the raw error (it can carry paths). */
export function exportFailureMessage(error: unknown): string {
  if (error instanceof MeetingNotDownloadedError) return MEETING_NOT_DOWNLOADED_MSG
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code
  return code === 'ENOENT' ? 'Meeting file not found.' : 'Could not export the meeting file.'
}
