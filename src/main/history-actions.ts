/**
 * History's single-meeting actions (Open, Export copy) read the meeting through the storage gateway.
 *
 * Invariants:
 *   - The meeting file is never read synchronously: a cloud-only, locked or kernel-blocked file answers
 *     within the gateway's read deadline (5 s) while the main thread keeps running.
 *   - `safeName` is a basename already checked by safeMeetingBasename; these helpers never build a path
 *     from anything else.
 */
import { join } from 'node:path'
import { storageAt } from './infra/storage/meetings-storage'
import type { ReadOptions } from './infra/storage/gateway'
import { decodeSaved, decryptToTemp, isEncryptedBytes } from './transcripts'

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
  // A FIFO, socket or device is refused before any read: a plain gateway read would still open it once
  // the detector answers. Classify's other verdicts never skip the read below.
  const fileClass = (await gateway.classify([safeName])).get(safeName)
  if (fileClass && 'isRegular' in fileClass && !fileClass.isRegular) return { ok: false, error: MEETING_NOT_READABLE_MSG }
  let read = await gateway.read(safeName)
  // The user's explicit Open hydrates this one cloud-only file (under a content permit, with progress).
  if (hydrate && (read.status === 'dataless' || read.status === 'unknown')) read = await gateway.read(safeName, { hydrate, onProgress })
  if (read.status === 'missing') return { ok: true, path, encrypted: false }
  if (read.status !== 'ok') return { ok: false, error: MEETING_NOT_READABLE_MSG }
  if (!isEncryptedBytes(read.bytes)) return { ok: true, path, encrypted: false }
  return { ok: true, path: decryptToTemp(path, read.bytes), encrypted: true }
}

/** The gateway-backed readSavedFile: the meeting's decoded text, '' when it cannot be decrypted on this
 *  device. Throws an ENOENT error when the file is missing and a plain error when it cannot be read, so
 *  callers keep readSavedFile's error handling. */
export async function readSavedMeeting(folder: string, safeName: string): Promise<string> {
  const read = await storageAt(folder).read(safeName)
  if (read.status === 'ok') return decodeSaved(read.bytes)
  const error = new Error(`meeting file ${read.status}`) as NodeJS.ErrnoException
  if (read.status === 'missing') error.code = 'ENOENT'
  throw error
}
