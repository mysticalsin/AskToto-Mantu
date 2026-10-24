import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { Settings } from '@shared/ipc'
import type { TranscriptLine } from '@shared/transcript-line'
import { draftFilename } from '../../infra/storage/draft-transcript-write-state'
import type { StorageGateway } from '../../infra/storage/gateway'
import { storageAt } from '../../infra/storage/meetings-storage'
import { sweepOrphanSavedTemps } from '../../infra/storage/orphan-temp-sweep'
import { erasureFenceReady, isErasureFenced, isErasureFencedName } from '../../memory-partition/erasure-fence'
import {
  appendIndexRow,
  decodeSavedMeetingAsync,
  ensureMeetingsFolder,
  recoverOrphanDrafts as promoteOrphanDrafts,
  resolveMeetingsFolder,
  writeSaved
} from '../../transcripts'
import {
  buildDraftTranscriptDocument,
  promoteDraftTranscript,
  recoveredDraftIndexFields
} from './draft-transcript-document'
import { currentLiveJournalLifecycle, endLiveMeetingJournal, purgeLiveMeetingJournal } from './live-journal-lifecycle'
import { readMeetingFields } from './meeting-document'
import { getMeetingSpeechReadLimitBytes, renderMeetingTranscriptAsync } from './meeting-speech'
import { stamp } from './transcript-document-format'
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
          // The save this draft belonged to is verified: its live journal is obsolete (sealed first, then removed).
          await endLiveMeetingJournal(draftIdentity.meetingStartedAt, 'finalized')
          await purgeLiveMeetingJournal(draftIdentity.meetingStartedAt)
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

const RECOVERED_TITLE = 'Recovered meeting'

/** True when a saved or recovered meeting already carries this canonical start instant (or one cannot be read). */
async function meetingExistsFor(settings: Settings, startedAt: number): Promise<boolean> {
  try {
    const folder = resolveMeetingsFolder(settings)
    const gateway = storageAt(folder)
    const listing = await gateway.list('')
    if (listing.status !== 'ok') return true
    const prefix = `${stamp(startedAt)}-`
    const date = new Date(startedAt).toISOString()
    for (const name of listing.names) {
      if (name.startsWith('.') || !name.startsWith(prefix) || !name.endsWith('.md')) continue
      const candidate = await documentOf(gateway, folder, name)
      // An unreadable same-stamp file might be this very meeting (another device, another key): never promote over it.
      if (!candidate) return true
      if (MEETING_TYPES.has(candidate.fields.type ?? '') && candidate.fields.date === date) return true
    }
    return false
  } catch {
    return true
  }
}

/**
 * Writes the recovered meeting for a journal that has no draft (crash before the first autosave). Title and mode are
 * defaults (the journal never saw them); the file is encrypted iff the user's `encryptTranscripts` is on, exactly
 * as a normal save would be (ASSUMED default of decision E).
 */
async function promoteJournalOnlyMeeting(
  settings: Settings,
  startedAt: number,
  lines: readonly TranscriptLine[]
): Promise<boolean> {
  // G82: nothing the owner erased is written back as a recovered meeting.
  if (isErasureFenced(startedAt)) return false
  try {
    const folder = ensureMeetingsFolder(settings)
    const listing = await storageAt(folder).list('')
    if (listing.status !== 'ok') return false
    const all = [...lines]
    const transcript = await renderMeetingTranscriptAsync(all)
    const document = promoteDraftTranscript(
      buildDraftTranscriptDocument(
        { title: RECOVERED_TITLE, mode: 'meeting', startedAt, lines: all, recap: '' },
        startedAt,
        RECOVERED_TITLE,
        transcript
      )
    )
    const stampPart = draftFilename(startedAt, stamp(startedAt)).slice('.autosave-draft-'.length, -'.md'.length)
    const occupied = new Set(listing.names)
    let name = `${stampPart}-recovered.md`
    for (let n = 2; occupied.has(name); n++) name = `${stampPart}-recovered-${n}.md`
    const encrypt = !!settings.encryptTranscripts
    await writeSaved(join(folder, name), document, encrypt)
    if (!encrypt) {
      const { dateStr, title, mode } = recoveredDraftIndexFields(document)
      appendIndexRow(folder, dateStr, title, mode, 0, name)
    }
    return true
  } catch {
    return false
  }
}

/** Launch recovery: finish journaled saves, drop drafts whose meeting was already saved, then promote true orphans. */
export async function recoverOrphanDrafts(settings: Settings): Promise<{ recovered: number }> {
  await erasureFenceReady() // G82: the fence file is read before any recovery asks it a question
  // A save killed between its temp write and its rename leaves `<meeting>.md.<hex>.tmp`; recovery rebuilds the
  // meeting from the draft or journal, so the stale temp is dead weight (and a stray copy of the transcript).
  try {
    await sweepOrphanSavedTemps(resolveMeetingsFolder(settings))
  } catch {
    // best effort: the sweep never blocks launch recovery
  }
  await launchResume?.(settings).catch(() => undefined)
  const savedDrafts = new Set<string>()
  await removeSavedMeetingDrafts(settings, savedDrafts)
  // G82: a draft that outlived an erasure is excluded from promotion like a draft whose meeting was already saved.
  try {
    const drafts = await storageAt(resolveMeetingsFolder(settings)).list('')
    if (drafts.status === 'ok') for (const name of drafts.names) if (isErasureFencedName(name)) savedDrafts.add(name)
  } catch {
    // a failed listing leaves the fence to the promotion pass's own listing failure
  }
  const journal = currentLiveJournalLifecycle()
  const result = await promoteOrphanDrafts(settings, savedDrafts, journal?.draftHooks() ?? null)
  if (!journal) return result
  // The live meeting journal's remaining work: journals with no draft, then retention. Never blocks launch.
  try {
    const listing = await storageAt(resolveMeetingsFolder(settings)).list('')
    // Without a readable folder listing no draft can be ruled out, so neither promotion nor the sweep may run.
    if (listing.status !== 'ok') return result
    const { promoted } = await journal.recoverRemaining({
      draftNames: listing.names.filter((name) => DRAFT_NAME.test(name)),
      meetingExists: (startedAt) => meetingExistsFor(settings, startedAt),
      promote: (startedAt, lines) => promoteJournalOnlyMeeting(settings, startedAt, lines)
    })
    return { recovered: result.recovered + promoted }
  } catch {
    return result
  }
}
