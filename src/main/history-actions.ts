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
import { decodeSaved, decryptToTemp, isEncryptedBytes } from './transcripts'

/** Shown on the History row when the gateway could not read the meeting (cloud-only, locked, slow). */
export const MEETING_NOT_READABLE_MSG =
  'Could not read the meeting file right now. If it is stored only in the cloud, make it available offline and try again.'

export type OpenTarget = { ok: true; path: string; encrypted: boolean } | { ok: false; error: string }

/** What History's "Open" hands to the OS: the meeting itself, or a decrypted temp copy when it is
 *  encrypted at rest. A missing file is handed over as-is, so the OS reports it as before. */
export async function meetingOpenTarget(folder: string, safeName: string): Promise<OpenTarget> {
  const path = join(folder, safeName)
  const read = await storageAt(folder).read(safeName)
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
