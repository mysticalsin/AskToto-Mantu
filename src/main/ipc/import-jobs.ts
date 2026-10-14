import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import {
  ImportAudioOfferSchema,
  ImportAudioStartBatchSchema,
  ImportAudioStartSchema,
  ImportJobIdSchema,
  IPC,
  type ImportCapabilityState,
  type ImportPersistenceState,
  type ImportPolicyState,
  type ImportJobView
} from '@shared/ipc'
import { consumePickedAudio as consumePickedAudioDefault, offerAudioPaths, pickAudioFile } from '../import-audio'
import type { ImportJob, ImportJobManager } from '../import-jobs'
import { ImportCheckpointUnavailableError } from '../import-job-checkpoint-contract'
import type { ImportOperationAuthority } from '../import-job-authority'

export interface ImportJobsIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  win: BrowserWindow | null
  assertMainWindow: (event: IpcMainInvokeEvent) => void
  requireAuth: () => boolean
  getImportJobs: () => ImportJobManager
  refreshImportAuthority: () => Promise<unknown>
  captureImportOperation: () => Promise<ImportOperationAuthority>
  assertImportAdmissionAllowed: () => unknown | Promise<unknown>
  assertImportAdmissionCurrent: () => void
  currentImportRetentionState: () => ImportPolicyState
  currentImportCapabilityState: () => ImportCapabilityState
  currentImportPersistenceState: () => ImportPersistenceState
  importJobView: (job: ImportJob) => ImportJobView
  consumeAudioToken?: typeof consumePickedAudioDefault
}

/** Real import handlers stay together so every token-consuming path shares the same main-owned gates. */
export function registerImportJobsIpc(options: ImportJobsIpcOptions): void {
  const {
    ipcMain,
    win,
    assertMainWindow,
    requireAuth,
    getImportJobs,
    refreshImportAuthority,
    captureImportOperation,
    assertImportAdmissionAllowed,
    assertImportAdmissionCurrent,
    currentImportRetentionState,
    currentImportCapabilityState,
    currentImportPersistenceState,
    importJobView,
    consumeAudioToken = consumePickedAudioDefault
  } = options

  ipcMain.handle(IPC.importAudioPick, async (event) => {
    assertMainWindow(event)
    if (!requireAuth()) return { error: 'Not signed in.' }
    return pickAudioFile(win)
  })
  ipcMain.handle(IPC.importAudioOffer, async (event, raw) => {
    assertMainWindow(event)
    if (!requireAuth()) return { error: 'Not signed in.' }
    const parsed = ImportAudioOfferSchema.safeParse(raw)
    if (!parsed.success) return { error: 'Could not prepare the selected recordings.' }
    return offerAudioPaths(parsed.data.paths)
  })
  ipcMain.handle(IPC.importAudioStart, async (event, raw) => {
    assertMainWindow(event)
    if (!requireAuth()) throw new Error('Not signed in.')
    const operation = await captureImportOperation()
    operation.assertCurrent()
    const parsed = ImportAudioStartSchema.parse(raw)
    assertImportPersistenceConfigured(currentImportPersistenceState)
    await assertImportAdmissionAllowed()
    operation.assertCurrent()
    const jobs = getImportJobs()
    await assertImportAdmissionAllowed()
    operation.assertCurrent()
    assertMainWindow(event)
    assertImportAdmissionCurrent()
    assertImportPersistenceConfigured(currentImportPersistenceState)
    const source = consumeAudioToken(parsed.token)
    const started = await jobs.start(source)
    operation.assertCurrent()
    assertMainWindow(event)
    if (!requireAuth()) throw new Error('Not signed in.')
    await assertImportAdmissionAllowed()
    operation.assertCurrent()
    assertMainWindow(event)
    if (!requireAuth()) throw new Error('Not signed in.')
    assertImportAdmissionCurrent()
    return importJobView(started)
  })
  ipcMain.handle(IPC.importAudioStartBatch, async (event, raw) => {
    assertMainWindow(event)
    if (!requireAuth()) throw new Error('Not signed in.')
    const operation = await captureImportOperation()
    operation.assertCurrent()
    const parsed = ImportAudioStartBatchSchema.parse(raw)
    assertImportPersistenceConfigured(currentImportPersistenceState)
    // Refresh before touching one-shot tokens, then synchronously recheck before every consume. Keeping
    // the consume loop free of awaits prevents a mid-batch policy transition from consuming a prefix.
    await assertImportAdmissionAllowed()
    operation.assertCurrent()
    const jobs = getImportJobs()
    await assertImportAdmissionAllowed()
    operation.assertCurrent()
    const sources = []
    const errors: string[] = []
    for (const token of parsed.tokens) {
      assertMainWindow(event)
      operation.assertCurrent()
      assertImportAdmissionCurrent()
      assertImportPersistenceConfigured(currentImportPersistenceState)
      try {
        sources.push(consumeAudioToken(token))
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
      }
    }
    if (!sources.length) throw new Error(errors[0] || 'Could not start the imports.')
    assertImportAdmissionCurrent()
    const started = await jobs.startMany(sources)
    operation.assertCurrent()
    assertMainWindow(event)
    if (!requireAuth()) throw new Error('Not signed in.')
    await assertImportAdmissionAllowed()
    operation.assertCurrent()
    assertMainWindow(event)
    if (!requireAuth()) throw new Error('Not signed in.')
    assertImportAdmissionCurrent()
    return started.map(importJobView)
  })
  ipcMain.handle(IPC.importJobsList, async (event) => {
    assertMainWindow(event)
    if (!requireAuth()) return unavailableSnapshot()
    try {
      const operation = await captureImportOperation()
      operation.assertCurrent()
      const snapshot = await getImportJobs().snapshot()
      operation.assertCurrent()
      assertMainWindow(event)
      if (!requireAuth()) return unavailableSnapshot()
      await operation.refreshSameScope()
      operation.assertCurrent()
      assertMainWindow(event)
      if (!requireAuth()) return unavailableSnapshot()
      const currentPolicyState = currentImportRetentionState()
      const persistenceState = currentImportPersistenceState()
      return {
        ...snapshot,
        jobs:
          requireAuth() && currentPolicyState === 'allowed' && persistenceState === 'configured'
            ? snapshot.jobs.map(importJobView)
            : [],
        policyState: currentPolicyState,
        policyBlocked: currentPolicyState !== 'allowed',
        capabilityState: currentImportCapabilityState(),
        persistenceState
      }
    } catch {
      return unavailableSnapshot()
    }
  })
  ipcMain.handle(IPC.importJobCancel, async (event, raw) => {
    assertMainWindow(event)
    if (!requireAuth()) throw new Error('Not signed in.')
    const operation = await captureImportOperation()
    operation.assertCurrent()
    const parsed = ImportJobIdSchema.parse(raw)
    assertImportPersistenceConfigured(currentImportPersistenceState)
    await getImportJobs().cancel(parsed.jobId)
    operation.assertCurrent()
  })
  ipcMain.handle(IPC.importJobResume, async (event, raw) => {
    assertMainWindow(event)
    if (!requireAuth()) throw new Error('Not signed in.')
    const operation = await captureImportOperation()
    operation.assertCurrent()
    const parsed = ImportJobIdSchema.parse(raw)
    await assertImportAdmissionAllowed()
    operation.assertCurrent()
    const resumed = await getImportJobs().resume(parsed.jobId)
    operation.assertCurrent()
    assertMainWindow(event)
    if (!requireAuth()) throw new Error('Not signed in.')
    await assertImportAdmissionAllowed()
    operation.assertCurrent()
    assertMainWindow(event)
    if (!requireAuth()) throw new Error('Not signed in.')
    assertImportAdmissionCurrent()
    return importJobView(resumed)
  })
  ipcMain.handle(IPC.importJobRemove, async (event, raw) => {
    assertMainWindow(event)
    if (!requireAuth()) throw new Error('Not signed in.')
    const operation = await captureImportOperation()
    operation.assertCurrent()
    const parsed = ImportJobIdSchema.parse(raw)
    await getImportJobs().remove(parsed.jobId)
    operation.assertCurrent()
  })
}

function unavailableSnapshot() {
  return {
    jobs: [],
    policyBlocked: true,
    policyState: 'unavailable' as const,
    capabilityState: 'unavailable' as const,
    persistenceState: 'unconfigured' as const,
    heldJobIds: [],
    policyHeldJobIds: [],
    inventoryOverflow: false,
    policyHoldOverflow: false
  }
}

function assertImportPersistenceConfigured(state: () => ImportPersistenceState): void {
  if (state() !== 'configured') throw new ImportCheckpointUnavailableError('UNCONFIGURED')
}
