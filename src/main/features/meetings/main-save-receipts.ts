import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { app } from 'electron'
import type { Settings } from '@shared/ipc'
import { enqueueIngest } from '../../brain/ingest'
import { scheduleRebuild } from '../../graphify'
import { storageAt } from '../../infra/storage/meetings-storage'
import { createReceiptJournal, type ReceiptJournalPort } from '../../infra/storage/transcript-receipt-journal'
import { mainLog } from '../../logger'
import { TranscriptSaveReceiptStore, type ReceiptLocator } from '../../transcript-save-receipts'
import { clearDraftTranscript, resolveMeetingsFolder } from '../../transcripts'
import { bindLaunchResume } from './draft-recovery'
import { savedRevisionNumber } from './transcript-checkpoint-binding'
import { resumeJournaledSaves, type ResumeOutcome } from './transcript-save-resume'

export type { TranscriptSaveSideEffect } from '../../transcript-save-receipts'

const folderId = (folder: string): string => createHash('sha256').update(resolve(folder)).digest('hex')

/** `<userData>/transcript-receipts/receipts.v1.json`, resolved on first use (after any profile `userData` change). */
function lazyMainJournal(): ReceiptJournalPort {
  let port: ReceiptJournalPort | null = null
  const get = (): ReceiptJournalPort =>
    (port ??= createReceiptJournal(join(app.getPath('userData'), 'transcript-receipts', 'receipts.v1.json')))
  return { load: () => get().load(), put: (rec) => get().put(rec), remove: (id) => get().remove(id) }
}

const locate: ReceiptLocator = (durablePath, settings, meetingStartedAt) => {
  const folder = resolve(resolveMeetingsFolder(settings))
  if (dirname(resolve(durablePath)) !== folder) return null
  return {
    savedBasename: basename(durablePath),
    folderIdSha256: folderId(folder),
    revision: savedRevisionNumber(meetingStartedAt)
  }
}

/** Resumes the journaled post-save stages of saves a previous process did not finish. */
export function resumeMainJournaledSaves(journal: ReceiptJournalPort, settings: Settings): Promise<ResumeOutcome> {
  const folder = resolveMeetingsFolder(settings)
  return resumeJournaledSaves({
    journal,
    folder: {
      join: (name) => join(folder, name),
      idSha256: folderId(folder),
      list: async () => {
        const listing = await storageAt(folder).list('')
        return listing.status === 'ok' ? listing.names : null
      }
    },
    stages: {
      'draft-cleanup': (path, startedAt) => clearDraftTranscript(settings, startedAt, path),
      rebuild: () => scheduleRebuild(),
      ingest: (path, options) => enqueueIngest(path, options)
    },
    deferredDefault: settings.brainConsolidation?.enabled ?? false,
    now: Date.now
  })
}

/**
 * The app's save receipt store with its durable journal (WP03-S09). Launch recovery resumes the journal before it
 * touches drafts, so a save killed after its durable write finishes its cleanup and ingest exactly as it began.
 */
export function createMainTranscriptSaveReceipts(): TranscriptSaveReceiptStore {
  const journal = lazyMainJournal()
  bindLaunchResume(async (settings) => {
    const outcome = await resumeMainJournaledSaves(journal, settings)
    if (outcome.error || outcome.finished || outcome.kept || outcome.dropped) {
      mainLog.info('transcript receipts resumed', outcome)
    }
  })
  return new TranscriptSaveReceiptStore(256, {
    journal,
    locate,
    newId: randomUUID,
    onError: (error) => mainLog.warn('transcript receipt journal write failed', String(error))
  })
}
