import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { Settings } from '@shared/ipc'
import type { StorageGateway } from '../../infra/storage/gateway'
import { storageAt } from '../../infra/storage/meetings-storage'
import {
  decodeSavedMeetingAsync,
  recoverOrphanDrafts as promoteOrphanDrafts,
  resolveMeetingsFolder
} from '../../transcripts'
import { readMeetingFields } from './meeting-document'
import { getMeetingSpeechReadLimitBytes } from './meeting-speech'
import { matchesSavedReceiptIdentity } from './saved-receipt-identity'
import { readRevisionCheckpoint } from './transcript-checkpoint'

/** `.autosave-draft-<stamp>-<ms>.md`, capturing the second-resolution stamp every saved meeting name starts with. */
const DRAFT_NAME = /^\.autosave-draft-(\d{4}-\d{2}-\d{2}_\d{6})-\d{3}\.md$/
const MEETING_TYPES = new Set(['meeting-transcript', 'meeting-summary'])

interface MeetingDocument {
  text: string
  fields: Record<string, string>
}

async function documentOf(gateway: StorageGateway, folder: string, name: string): Promise<MeetingDocument | null> {
  const maxBytes = getMeetingSpeechReadLimitBytes()
  const read = await gateway.read(name, maxBytes ? { maxBytes } : {})
  if (read.status !== 'ok') return null
  const decoded = await decodeSavedMeetingAsync(read.bytes, false, join(folder, name))
  return decoded.ok ? { text: decoded.text, fields: readMeetingFields(decoded.text) } : null
}

function identityOf(document: MeetingDocument): { meetingStartedAt: number; revision: number } | null {
  if (document.fields.type !== 'meeting-transcript-draft') return null
  const date = document.fields.date
  if (!date) return null
  const meetingStartedAt = Date.parse(date)
  if (!Number.isSafeInteger(meetingStartedAt)) return null
  const revision = readRevisionCheckpoint(document.text)?.revision ?? 0
  // The round-55 verifier accepts saved meeting types only. Validate the draft's identity fields with the same
  // verifier after projecting its one draft type marker to the saved transcript type.
  const savedIdentityView = document.text.replace(/^type: meeting-transcript-draft\r?$/m, 'type: meeting-transcript')
  return savedIdentityView !== document.text &&
    matchesSavedReceiptIdentity(savedIdentityView, meetingStartedAt, revision)
    ? { meetingStartedAt, revision }
    : null
}

/**
 * GATE-07: one meeting identity yields exactly one saved or recovered meeting. A draft still on disk next to a
 * saved or recovered meeting with the same verified identity (canonical `date:` instant and transcript revision)
 * is the leftover of a save whose draft cleanup never finished (killed after the save, or mid-unlink), so it is
 * removed instead of being promoted into a duplicate. Same-stamp candidates that cannot be verified or have a
 * different identity keep their draft on disk for a later recovery attempt.
 */
export async function removeSavedMeetingDrafts(
  settings: Settings,
  savedDrafts = new Set<string>()
): Promise<{ removed: number }> {
  let removed = 0
  try {
    const folder = resolveMeetingsFolder(settings)
    const gateway = storageAt(folder)
    const listing = await gateway.list('')
    if (listing.status !== 'ok') return { removed }
    for (const name of listing.names) {
      const stampPart = DRAFT_NAME.exec(name)?.[1]
      if (!stampPart) continue
      try {
        const draft = await documentOf(gateway, folder, name)
        if (!draft) continue
        const draftIdentity = identityOf(draft)
        let preserveForUnverifiedCandidate = false
        const candidates = listing.names.filter((n) => n.startsWith(`${stampPart}-`) && n.endsWith('.md'))
        for (const candidate of candidates) {
          const saved = await documentOf(gateway, folder, candidate)
          if (!saved) {
            preserveForUnverifiedCandidate = true
            continue
          }
          if (!MEETING_TYPES.has(saved.fields.type ?? '') || saved.fields.date !== draft.fields.date) continue
          if (
            !draftIdentity ||
            !matchesSavedReceiptIdentity(saved.text, draftIdentity.meetingStartedAt, draftIdentity.revision)
          ) {
            preserveForUnverifiedCandidate = true
            continue
          }
          // Exclude the verified draft from promotion even if a transient lock prevents its deletion.
          savedDrafts.add(name)
          await unlink(join(folder, name))
          removed++
          break
        }
        if (preserveForUnverifiedCandidate) savedDrafts.add(name)
      } catch {
        // one unreadable or locked draft never blocks the others; it is retried on the next launch
      }
    }
  } catch {
    // best effort: recovery never blocks launch
  }
  return { removed }
}

let launchResume: ((settings: Settings) => Promise<void>) | null = null

/** Binds the durable receipt resumption that launch recovery runs first; the disposer unbinds only its own. */
export function bindLaunchResume(resume: (settings: Settings) => Promise<void>): () => void {
  launchResume = resume
  return () => {
    if (launchResume === resume) launchResume = null
  }
}

/** Launch recovery: finish journaled saves, drop drafts whose meeting was already saved, then promote true orphans. */
export async function recoverOrphanDrafts(settings: Settings): Promise<{ recovered: number }> {
  await launchResume?.(settings).catch(() => undefined)
  const savedDrafts = new Set<string>()
  await removeSavedMeetingDrafts(settings, savedDrafts)
  return promoteOrphanDrafts(settings, savedDrafts)
}
