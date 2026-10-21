/**
 * import-audio-ipc.ts — the renderer-facing import-audio job channels: pick, offer, start, batch start,
 * list, cancel, resume and remove.
 *
 * Moved verbatim from the main entry point (the job manager stays main-owned so navigation and overlay
 * closure cannot interrupt a job). Each handler keeps its main-window sender gate and sign-in gate. The
 * decoder-window channels share main-process decoder state and stay in the entry point.
 */
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import {
  IPC,
  ImportAudioStartSchema,
  ImportAudioStartBatchSchema,
  ImportAudioOfferSchema,
  ImportJobIdSchema
} from '@shared/ipc'
import { pickAudioFile, consumePickedAudio, offerAudioPaths } from '../import-audio'
import * as importJobsSnapshotIpc from '../import-jobs-snapshot-ipc'
import type { ImportJobManager } from '../import-jobs'

export interface ImportAudioIpcDependencies {
  ipcMain: Pick<IpcMain, 'handle'>
  /** Main-window top frame only. */
  assertMainWindow: (event: IpcMainInvokeEvent) => void
  requireAuth: () => boolean
  getWindow: () => BrowserWindow | null
  getImportJobs: () => ImportJobManager
  importJobView: ReturnType<typeof importJobsSnapshotIpc.createImportJobView>
}

export function registerImportAudioIpc(deps: ImportAudioIpcDependencies): void {
  const { ipcMain, assertMainWindow, requireAuth, getImportJobs, importJobView } = deps
  ipcMain.handle(IPC.importAudioPick, async (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return { error: 'Not signed in.' }
    return pickAudioFile(deps.getWindow())
  })
  ipcMain.handle(IPC.importAudioOffer, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) return { error: 'Not signed in.' }
    const parsed = ImportAudioOfferSchema.safeParse(raw)
    if (!parsed.success) return { error: 'Could not prepare the selected recordings.' }
    return offerAudioPaths(parsed.data.paths)
  })
  ipcMain.handle(IPC.importAudioStart, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) throw new Error('Not signed in.')
    const parsed = ImportAudioStartSchema.parse(raw)
    const jobs = getImportJobs()
    return importJobView(await jobs.start(consumePickedAudio(parsed.token)))
  })
  ipcMain.handle(IPC.importAudioStartBatch, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) throw new Error('Not signed in.')
    const parsed = ImportAudioStartBatchSchema.parse(raw)
    const jobs = getImportJobs()
    const sources = []
    const errors: string[] = []
    for (const token of parsed.tokens) {
      try {
        sources.push(consumePickedAudio(token))
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err))
      }
    }
    if (!sources.length) throw new Error(errors[0] || 'Could not start the imports.')
    return (await jobs.startMany(sources)).map(importJobView)
  })
  ipcMain.handle(IPC.importJobsList, (e) => {
    assertMainWindow(e)
    return importJobsSnapshotIpc.listImportJobsSnapshot(
      e,
      deps.getWindow,
      () => getImportJobs().snapshot(),
      importJobView
    )
  })
  ipcMain.handle(IPC.importJobCancel, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) throw new Error('Not signed in.')
    const parsed = ImportJobIdSchema.parse(raw)
    await getImportJobs().cancel(parsed.jobId)
  })
  ipcMain.handle(IPC.importJobResume, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) throw new Error('Not signed in.')
    const parsed = ImportJobIdSchema.parse(raw)
    return importJobView(await getImportJobs().resume(parsed.jobId))
  })
  ipcMain.handle(IPC.importJobRemove, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) throw new Error('Not signed in.')
    const parsed = ImportJobIdSchema.parse(raw)
    await getImportJobs().remove(parsed.jobId)
  })
}
