import { basename, join } from 'node:path'
import type { Settings } from '@shared/ipc'
import { hasMeetingFlag, parse, readMeetingFields as frontmatter } from './features/meetings/meeting-document'
import { decodeStoredMeetingSpeechAsync, getMeetingSpeechReadLimitBytes } from './features/meetings/meeting-speech'
import { DRAFT_FILENAME, UNREADABLE } from './history-read'
import { storageAt } from './infra/storage/meetings-storage'
import { resolveMeetingsFolder, decodeSavedMeetingAsync, isEncryptedBytes } from './transcripts'

const OWNED_FRONTMATTER_TYPES = new Set(['meeting-transcript', 'meeting-summary', 'meeting-transcript-draft', 'note'])

/** Shared by ownership checks and retention. Timestamp-shaped meeting files are Métis-owned. */
export const FILENAME_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})-/

/** Disk-backed confidential check for MCP push; unknown and unreadable content fails closed. */
export async function isMeetingConfidentialOnDisk(settings: Settings, file: string): Promise<boolean> {
  const safeName = basename(file)
  if (!safeName || !safeName.endsWith('.md') || safeName === 'index.md' || safeName === 'README.md') return true
  const folder = resolveMeetingsFolder(settings)
  const maxBytes = getMeetingSpeechReadLimitBytes()
  const read = await storageAt(folder).read(safeName, { ...(maxBytes ? { maxBytes } : {}) })
  if (read.status !== 'ok') return true
  const decoded = await decodeSavedMeetingAsync(read.bytes, false, join(folder, safeName))
  if (!decoded.ok) return true
  let speech: Awaited<ReturnType<typeof decodeStoredMeetingSpeechAsync>>
  try {
    speech = await decodeStoredMeetingSpeechAsync(decoded.text)
  } catch {
    return true
  }
  if (!speech.ok || !speech.publicMarkdown || !parse(speech.publicMarkdown)) return true
  return hasMeetingFlag(speech.publicMarkdown, 'confidential')
}

/** Tri-state ownership verdict: unreadable is never treated as confirmed unrelated user data. */
export async function isOwnedMeetingFile(folder: string, file: string): Promise<boolean | typeof UNREADABLE> {
  if (DRAFT_FILENAME.test(file) || FILENAME_TIMESTAMP.test(file)) return true
  const maxBytes = getMeetingSpeechReadLimitBytes()
  const raw = await storageAt(folder).read(file, { ...(maxBytes ? { maxBytes } : {}) })
  if (raw.status !== 'ok') return UNREADABLE
  try {
    const decoded = await decodeSavedMeetingAsync(raw.bytes, false, join(folder, file))
    if (!decoded.ok) return isEncryptedBytes(raw.bytes)
    if (!decoded.text) return isEncryptedBytes(raw.bytes)
    return OWNED_FRONTMATTER_TYPES.has(frontmatter(decoded.text).type)
  } catch {
    return false
  }
}
