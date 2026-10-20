import { access } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type { IpcMain, IpcMainInvokeEvent, MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import { DiscardSavedTranscriptPayloadSchema, IPC, type Settings } from '@shared/ipc'
import type { exciseDeletedMeeting, requestSourceRefresh } from '../brain/ingest'
import type { publishMeetingCard } from '../brain/publish'
import type { auditLog } from '../logger'
import type { safeMeetingBasename } from '../meeting-path'
import type { deleteMeetingAtPath, recallRead } from '../recall'
import type { TranscriptSaveReceiptStore } from '../transcript-save-receipts'
import type { resolveMeetingsFolder } from '../transcripts'

export interface DiscardSavedTranscriptIpcDependencies {
  ipcMain: Pick<IpcMain, 'handle'>
  assertMainWindow: (event: IpcMainInvokeEvent) => void
  requireAuth: () => boolean
  captureAuthSessionBoundary: () => () => boolean
  authSessionGeneration: () => number
  receipts: Pick<
    TranscriptSaveReceiptStore,
    | 'sealMeetingAndJoin'
    | 'durablePathsForMeeting'
    | 'markMeetingDiscarded'
    | 'markDurablePathDiscarded'
    | 'releaseMeetingSeal'
  >
  getSettings: () => Settings
  resolveMeetingsFolder: typeof resolveMeetingsFolder
  safeMeetingBasename: typeof safeMeetingBasename
  recallRead: (file: string) => ReturnType<typeof recallRead>
  acquireGraphBuildFence: () => Promise<() => void>
  /** Shows the native confirmation, parented to the main window when one exists. */
  showMessageBox: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>
  deleteMeetingAtPath: typeof deleteMeetingAtPath
  auditLog: typeof auditLog
  publishMeetingCard: typeof publishMeetingCard
  warn: (message: string) => void
  exciseDeletedMeeting: typeof exciseDeletedMeeting
  requestSourceRefresh: typeof requestSourceRefresh
}

/** Async existence check with existsSync semantics: any access failure (missing, dangling, denied) is false. */
function pathExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false
  )
}

export function registerDiscardSavedTranscriptIpc(deps: DiscardSavedTranscriptIpcDependencies): void {
  // Explicit live-meeting Disregard resolves durable files from main-owned save receipts. The exact
  // receipt path and captured folder are retained through confirmation, so a changed meetings-folder
  // setting can never turn a basename into a deletion in a different folder.
  deps.ipcMain.handle(IPC.discardSavedTranscript, async (e, raw) => {
    deps.assertMainWindow(e)
    if (!deps.requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const authCurrent = deps.captureAuthSessionBoundary()
    const parsed = DiscardSavedTranscriptPayloadSchema.safeParse(raw)
    if (!parsed.success || !authCurrent()) return { ok: false, error: 'Could not verify this meeting.' }

    const generation = deps.authSessionGeneration()
    await deps.receipts.sealMeetingAndJoin(parsed.data.startedAt, generation)
    let releaseGraphBuildFence: (() => void) | undefined
    try {
      if (!authCurrent()) return { ok: false, error: 'Sign-in changed before deletion.', deletedPaths: [] as string[] }
      const paths = deps.receipts.durablePathsForMeeting(parsed.data.startedAt, generation)
      if (parsed.data.path && !paths.some((entry) => resolve(entry.path) === resolve(parsed.data.path!))) {
        // Receipt eviction is recoverable only when the saved file proves it belongs to this live meeting.
        const candidate = resolve(parsed.data.path)
        const currentSettings = deps.getSettings()
        const currentFolder = resolve(deps.resolveMeetingsFolder(currentSettings))
        const safeName = deps.safeMeetingBasename(candidate)
        if (safeName && resolve(join(currentFolder, safeName)) === candidate && (await pathExists(candidate))) {
          const identity = await deps.recallRead(safeName)
          if (!authCurrent())
            return { ok: false, error: 'Sign-in changed before deletion.', deletedPaths: [] as string[] }
          if (!identity.ok || identity.startedAt !== parsed.data.startedAt) {
            return {
              ok: false,
              error: 'The saved transcript could not be verified. Try Disregard again.',
              deletedPaths: [] as string[]
            }
          }
          paths.push({ path: candidate, settings: currentSettings })
        } else if (await pathExists(candidate)) {
          return {
            ok: false,
            error: 'The saved transcript could not be verified. Try Disregard again.',
            deletedPaths: [] as string[]
          }
        }
      }
      if (!paths.length) {
        if (!authCurrent())
          return { ok: false, error: 'Sign-in changed before deletion.', deletedPaths: [] as string[] }
        deps.receipts.markMeetingDiscarded(parsed.data.startedAt, generation)
        return { ok: true, deletedPaths: [] as string[] }
      }

      // Receipt-owned rebuilds were joined above; this fence also joins a manual/already-started
      // build and queues later graph builds until deletion and derived-data cleanup are complete.
      releaseGraphBuildFence = await deps.acquireGraphBuildFence()
      if (!authCurrent()) return { ok: false, error: 'Sign-in changed before deletion.', deletedPaths: [] as string[] }

      const label = parsed.data.title?.trim() || 'this meeting'
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
      const { response } = await deps.showMessageBox(dialogOpts)
      if (response !== 0) return { ok: false, error: 'cancelled', deletedPaths: [] as string[] }
      if (!authCurrent()) return { ok: false, error: 'Sign-in changed before deletion.', deletedPaths: [] as string[] }
      // The confirmed discard permanently closes save admission before the first delete awaits.
      deps.receipts.markMeetingDiscarded(parsed.data.startedAt, generation)
      const deletedPaths: string[] = []
      for (const entry of paths) {
        if (!authCurrent()) return { ok: false, error: 'Sign-in changed before deletion.', deletedPaths }
        const result = await deps.deleteMeetingAtPath(entry.settings, entry.path)
        if (!result.ok && result.error !== 'Meeting file not found.') {
          return { ok: false, error: result.error || 'Could not delete the saved transcript.', deletedPaths }
        }
        deps.receipts.markDurablePathDiscarded(entry.path, generation)
        deletedPaths.push(entry.path)
        const safeName = basename(entry.path)
        deps.auditLog('transcript.deleted', { file: safeName })
        await deps.publishMeetingCard(entry.settings, safeName).catch((error) => {
          const detail = error instanceof Error ? error.message : String(error)
          deps.warn(`[publish] could not remove the note card for a deleted meeting: ${detail}`)
        })
        await deps
          .exciseDeletedMeeting(entry.settings, safeName)
          .then(({ gone }) => {
            if (!gone) deps.warn(`[brain] extraction for a deleted meeting could not be removed: ${safeName}`)
          })
          .catch((error) => {
            const detail = error instanceof Error ? error.message : String(error)
            deps.warn(`[brain] excise failed for a deleted meeting: ${detail}`)
          })
        await deps.requestSourceRefresh(entry.settings)
      }
      return { ok: true, deletedPaths }
    } finally {
      releaseGraphBuildFence?.()
      deps.receipts.releaseMeetingSeal(parsed.data.startedAt, generation)
    }
  })
}
