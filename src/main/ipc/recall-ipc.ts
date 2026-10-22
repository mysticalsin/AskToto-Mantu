/**
 * recall-ipc.ts — the History/Recall IPC surface for one saved meeting: read, plaintext export, delete,
 * rename, recap edit, confidential and CRM-pushed flags, speaker backfill, debrief, and the delete-all
 * erasure flow.
 *
 * Moved verbatim from the main entry point: every handler keeps its channel, main-window sender gate, auth
 * gate, argument validation, audit event and return shape. The native dialogs and the one plaintext file
 * write come in through the dependencies so this module stays free of window state and synchronous fs.
 */
import { basename, join } from 'node:path'
import type { IpcMain, IpcMainInvokeEvent, MessageBoxOptions, SaveDialogOptions } from 'electron'
import {
  IPC,
  RenameMeetingPayloadSchema,
  UpdateRecapPayloadSchema,
  SetConfidentialPayloadSchema,
  SetCrmPushedPayloadSchema,
  RecallBackfillSpeakersPayloadSchema,
  type RecallExportPlainResult
} from '@shared/ipc'
import { getSettings } from '../store'
import { mainLog, auditLog } from '../logger'
import { enqueueIngest, exciseDeletedMeeting, requestSourceRefresh } from '../brain/ingest'
import { publishAll, publishMeetingCard, removeWiki } from '../brain/publish'
import { purgeBrain } from '../brain/store'
import { safeMeetingBasename } from '../meeting-path'
import { resolveMeetingsFolder, appendDebrief } from '../transcripts'
import { readSavedMeeting } from '../history-actions'
import { listMeetings } from '../history-read'
import {
  recallRead,
  openExplicitly,
  deleteMeeting,
  renameMeeting,
  updateMeetingRecap,
  setMeetingConfidential,
  setMeetingCrmPushed,
  deleteAllMeetings
} from '../recall'
import { purgeGraphArtifacts, scheduleRebuild } from '../graphify'

export interface RecallIpcDependencies {
  ipcMain: Pick<IpcMain, 'handle'>
  /** Main-window top frame only. */
  assertMainWindow: (event: IpcMainInvokeEvent) => void
  requireAuth: () => boolean
  /** Native confirm dialog, attached to the overlay window when it exists. */
  showMessageBox: (options: MessageBoxOptions) => Promise<{ response: number }>
  /** Native save dialog, attached to the overlay window when it exists. */
  showSaveDialog: (options: SaveDialogOptions) => Promise<{ canceled: boolean; filePath?: string }>
  downloadsPath: () => string
  /** Writes the user-chosen plaintext export copy. */
  writeTextFile: (path: string, text: string) => void
  backfillSpeakerNames: (file: string) => Promise<{ ok: boolean; named?: number; error?: string }>
}

export function registerRecallIpc(deps: RecallIpcDependencies): void {
  const { ipcMain, assertMainWindow, requireAuth, showMessageBox, showSaveDialog, downloadsPath, writeTextFile } = deps
  const { backfillSpeakerNames } = deps
  // Recall read: load a saved meeting back for "Resume session" (decode + parse the markdown).
  ipcMain.handle(IPC.recallRead, async (e, file: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    return openExplicitly(
      String(file ?? ''),
      (event) => e.sender.send(IPC.recallHydration, event),
      (options) => recallRead(String(file ?? ''), options)
    )
  })

  // Recall export: a user-initiated DECRYPTED markdown copy of ONE saved meeting, so an external tool —
  // Claude local ingesting it into the second brain, an email, an archive — can read it even when
  // at-rest encryption is on. Deliberately per-meeting and behind a native save dialog: never a bulk
  // decrypt, and the plaintext lands only where the user explicitly pointed. Audited.
  ipcMain.handle(IPC.recallExportPlain, async (e, file: unknown): Promise<RecallExportPlainResult> => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const safeName = safeMeetingBasename(file)
    // Same guard set as every recall.ts sibling: only meeting .md files, never the plaintext index/README.
    if (!safeName) {
      return { ok: false, error: 'Not a saved meeting file.' }
    }
    try {
      // Decodes the ATKENC2 envelope when the file is encrypted; read through the storage gateway.
      const text = await readSavedMeeting(resolveMeetingsFolder(getSettings()), safeName)
      // readSavedMeeting returns '' (never throws) when the envelope can't be decrypted on this device —
      // without this guard the export would "succeed" as a 0-byte file (adversarial review finding).
      if (!text) return { ok: false, error: 'Meeting file could not be decrypted on this device.' }
      const dialogOpts = {
        title: 'Export meeting copy',
        defaultPath: join(downloadsPath(), safeName),
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      }
      const res = await showSaveDialog(dialogOpts)
      if (res.canceled || !res.filePath) return { ok: false, cancelled: true }
      writeTextFile(res.filePath, text)
      auditLog('recall.export', { file: safeName })
      return { ok: true, path: res.filePath }
    } catch (err) {
      // Sanitized like recall.ts's siblings — never the raw err.message (it can carry absolute paths).
      const code = (err as NodeJS.ErrnoException | null)?.code
      return { ok: false, error: code === 'ENOENT' ? 'Meeting file not found.' : 'Could not export the meeting file.' }
    }
  })

  // Recall delete: GDPR right-to-erasure for a saved meeting — removes the file + its index row.
  // Confirmed with a native, unmissable modal BEFORE deleting (sync — blocks until the user answers) so a
  // single click is unambiguous: no "did that register?" two-click pattern that's easy to misread as broken.
  ipcMain.handle(IPC.recallDelete, async (e, file: unknown, title: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const safeName = safeMeetingBasename(file)
    if (!safeName) return { ok: false, error: 'Not a saved meeting file.' }
    const label = typeof title === 'string' && title.trim() ? title.trim() : 'this meeting'
    const dialogOpts = {
      type: 'warning' as const,
      title: 'Delete meeting',
      message: `Delete "${label}"?`,
      detail:
        'This removes the saved transcript, its notes, and its extracted knowledge from this device. This cannot be undone.',
      buttons: ['Delete', 'Cancel'],
      defaultId: 1,
      cancelId: 1
    }
    const { response } = await showMessageBox(dialogOpts)
    if (response !== 0) return { ok: false, error: 'cancelled' }
    const result = await deleteMeeting(safeName)
    if (result.ok) {
      auditLog('transcript.deleted', { file: safeName })
      // The published note card is derived from a file that no longer exists — publishMeetingCard unlinks
      // it in exactly that case (and no-ops when publishing is off). Done here rather than left to the
      // next rebuild: requestSourceRefresh below bails on a busy queue, a pending replay, or a profile
      // with no usable provider, which would leave the deleted meeting's plaintext card on disk for good.
      await publishMeetingCard(getSettings(), safeName).catch((error) => {
        const detail = error instanceof Error ? error.message : String(error)
        mainLog.warn(`[publish] could not remove the note card for a deleted meeting: ${detail}`)
      })
      // MQA-230: the deleted meeting's own extraction JSON + ledger row need no provider to remove —
      // erase them NOW rather than leaving them to the refresh below, which no-ops while no provider is
      // usable. Best-effort like the card removal above: a locked file must not fail the delete the user
      // already confirmed, but it is logged so the residue is never silent.
      await exciseDeletedMeeting(getSettings(), safeName)
        .then(({ gone }) => {
          if (!gone) mainLog.warn(`[brain] extraction for a deleted meeting could not be removed: ${safeName}`)
        })
        .catch((error) => {
          const detail = error instanceof Error ? error.message : String(error)
          mainLog.warn(`[brain] excise failed for a deleted meeting: ${detail}`)
        })
      // D4-13: the dialog promises the extracted knowledge is gone, but graph.json (topics, notes, Connections) is
      // built from the saved meetings. Drop it and re-derive it from what remains.
      purgeGraphArtifacts()
      void scheduleRebuild().catch((error) => {
        const detail = error instanceof Error ? error.message : String(error)
        mainLog.warn(`[graphify] rebuild after a meeting delete failed: ${detail}`)
      })
      await requestSourceRefresh(getSettings())
    }
    return result
  })

  // Recall rename: fix an auto-generated (recap-derived) title after the fact. Updates the frontmatter
  // `title:` value + the file's H1 in place — the file itself is never renamed, so index.md rows and
  // knowledge-graph links (both keyed by filename) stay valid. No confirm dialog: unlike delete, this is
  // trivially reversible (rename again). Not audit-logged: 'transcript.renamed' isn't in logger.ts's
  // AuditEvent union, and logger.ts is outside this feature's owned files.
  ipcMain.handle(IPC.recallRename, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const parsed = RenameMeetingPayloadSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message || 'Invalid rename request.' }
    const result = await renameMeeting(getSettings(), parsed.data.file, parsed.data.title)
    if (result.ok) {
      auditLog('transcript.renamed', { file: basename(parsed.data.file) })
      await enqueueIngest(join(resolveMeetingsFolder(getSettings()), basename(parsed.data.file)), { force: true })
    }
    return result
  })

  // Recall update-recap: edit a saved meeting's recap ("## Notes & follow-ups") after the fact — fix a
  // mis-heard name, tick an action item, annotate. Rewrites only that section in place; frontmatter + the
  // full transcript are untouched, and the file is never renamed (mirrors recallRename's reasoning). No
  // confirm dialog: reversible by editing again. Audit-logged (metadata only — never the recap text) for
  // parity with 'transcript.renamed'.
  ipcMain.handle(IPC.recallUpdateRecap, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const parsed = UpdateRecapPayloadSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message || 'Invalid edit request.' }
    const result = await updateMeetingRecap(getSettings(), parsed.data.file, parsed.data.recap, parsed.data.recapStatus)
    if (result.ok) {
      auditLog('transcript.recap_edited', { file: basename(parsed.data.file) })
      await enqueueIngest(join(resolveMeetingsFolder(getSettings()), basename(parsed.data.file)), { force: true })
    }
    return result
  })

  // Task MI-5: flag/unflag a saved meeting as confidential — excludes it from every published wiki
  // surface (note card, entity timelines/current-facts, indexes). Same guard pattern as
  // recallUpdateRecap; audit-logged. A full republish is the simplest correct way to make the exclusion
  // (or its reversal) take effect everywhere at once — cheap at this app's single-exec scale, and it's
  // the exact same idempotent full regen rebuildAll already relies on.
  ipcMain.handle(IPC.recallSetConfidential, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const parsed = SetConfidentialPayloadSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message || 'Invalid request.' }
    const s = getSettings()
    const result = await setMeetingConfidential(s, parsed.data.file, parsed.data.confidential)
    if (result.ok) {
      auditLog('transcript.confidential_set', {
        file: basename(parsed.data.file),
        confidential: parsed.data.confidential
      })
      // MQA-075: the republish IS the enforcement — the wiki is static markdown, so until it regenerates
      // the meeting's title/TL;DR/decisions/deal facts are still on every published page. Fired detached
      // it could fail (a locked wiki file, an EPERM mkdir) while this handler had already returned ok, so
      // Review painted "excluded from published intelligence" over pages that still contain the meeting —
      // and the rejection escaped to the unhandledRejection handler, writing a crash log for a non-crash.
      // Await it and report the truth instead; the frontmatter write itself is already durable.
      try {
        await publishAll(s)
      } catch (error) {
        mainLog.error(`[confidential] republish failed: ${error instanceof Error ? error.message : String(error)}`)
        return {
          ok: false,
          error:
            'Flag saved, but the published pages could not be updated — this meeting may still appear in your published wiki. Try again.'
        }
      }
    }
    return result
  })

  // MQA-092: durable record that this recap already reached the CRM. Same guard shape as every other
  // recall write (main window, requireAuth, zod, basename re-checked inside recall.ts). No republish
  // here — unlike the confidential flag, this marker changes nothing about what is published; it only
  // stops the push panel re-offering a send that already happened.
  ipcMain.handle(IPC.recallSetCrmPushed, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const parsed = SetCrmPushedPayloadSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message || 'Invalid request.' }
    return setMeetingCrmPushed(getSettings(), parsed.data.file, parsed.data.key)
  })

  // Speaker Intelligence: manual (re)trigger of the Teams-transcript speaker-name backfill for a past
  // meeting — Review's automatic post-save attempt may have found nothing yet (the Teams transcript can
  // take a few minutes to finish processing after the meeting ends). Same guard pattern as the other
  // recall writes; the actual work is shared with the automatic post-save path (see backfillSpeakerNames).
  ipcMain.handle(IPC.recallBackfillSpeakers, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const parsed = RecallBackfillSpeakersPayloadSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message || 'Invalid request.' }
    return backfillSpeakerNames(parsed.data.file)
  })

  // 90-Second Debrief (innovation #6): the user's off-record gut-read, appended to the saved meeting.
  // Same file → inherits encryption/retention/deletion, and the brain re-ingest below folds the unsaid
  // observations into signals on the next extraction pass.
  ipcMain.handle(IPC.debriefSave, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const p = raw as { file?: unknown; text?: unknown }
    const safeName = safeMeetingBasename(p?.file)
    const text = String(p?.text ?? '').slice(0, 8000)
    if (!safeName || !text.trim()) return { ok: false, error: 'Nothing to save.' }
    const s = getSettings()
    const result = await appendDebrief(s, safeName, text)
    if (result.ok) {
      auditLog('transcript.debrief', { file: safeName })
      await enqueueIngest(join(resolveMeetingsFolder(s), safeName), { force: true }) // fold the unsaid layer into the brain
    }
    return result
  })

  // Delete EVERYTHING: every saved meeting + the index + the knowledge graph. For a GDPR/CCPA erasure
  // request or a full account wipe — not the same as recallDelete's one-at-a-time flow. Extra-emphatic
  // confirm (shows the real count, defaults to Cancel) since this is the single most destructive action
  // in the app and cannot be undone.
  ipcMain.handle(IPC.recallDeleteAll, async (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const meetings = await listMeetings()
    const dialogOpts = {
      type: 'warning' as const,
      title: 'Delete all Métis data',
      // Zero meetings is NOT an empty profile: the derived artifacts (.brain, the published wiki mirror,
      // the graph) outlive the transcripts they were built from, so a folder whose meetings were already
      // deleted one at a time still has plaintext to erase. This flow runs for it too.
      message: meetings.length
        ? `Delete all ${meetings.length} saved meeting${meetings.length === 1 ? '' : 's'}?`
        : 'Delete all Métis data on this device?',
      detail:
        'This permanently removes every saved transcript, note, and the knowledge graph from this device. This cannot be undone.',
      buttons: ['Delete everything', 'Cancel'],
      defaultId: 1,
      cancelId: 1
    }
    const { response } = await showMessageBox(dialogOpts)
    if (response !== 0) return { ok: false, error: 'cancelled' }
    const result = await deleteAllMeetings()
    purgeGraphArtifacts() // legacy userData/graph artifacts + the runner's graphify-out/ manifest
    const settings = getSettings()
    const brainPurge = purgeBrain(settings, { mode: 'erase' }) // the `.brain/` knowledge store — entities, quotes, graph
    // The wiki mirror is that same derived knowledge in CLEARTEXT (publish.ts writes it with
    // `encrypt: false` by design), so an erasure that skipped it would leave a readable copy of every
    // meeting, person and open commitment behind — and, with the brain gone, one nothing can ever prune.
    // Unconditional, not gated on publishBrainPages: a mirror survives the publish OFF edge whenever that
    // removal failed, and this promise is "everything", not "everything currently enabled".
    const wiki = removeWiki(getSettings())
    auditLog('transcript.deleted', {
      bulk: true,
      deleted: result.deleted,
      failed: result.failed.length,
      brainPurged: brainPurge.ok,
      wikiRemoved: wiki.ok
    })
    if (!brainPurge.ok) {
      return {
        ...result,
        ok: false,
        error:
          'Deleted the transcripts, but the Mantu Intelligence data could not be fully removed. Close anything using the meetings folder, then try again.'
      }
    }
    if (!wiki.ok) {
      return {
        ...result,
        ok: false,
        error:
          'Deleted the transcripts, but the published wiki pages could not be removed. Close anything using the meetings folder, then try again.'
      }
    }
    return result
  })
}
