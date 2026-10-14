import { app, type BrowserWindow, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { requireAuth, captureAuthSessionBoundary } from './auth'
import { getSettings } from './store'
import { getSettingsObservationEpoch } from './settings-observation'
import type { ImportJob, ImportJobsSnapshot } from './import-job-types'
import type { ImportJobView, ImportJobsSnapshot as SharedImportJobsSnapshot } from '@shared/import-jobs'

interface SnapshotScopeReaders {
  currentWindow: () => unknown
  documentEpoch: (sender: WebContents) => number
  currentProfilePath: () => string
  refreshSettings: () => unknown
  settingsEpoch: () => number
  captureAuthBoundary: () => () => boolean
}

export function createImportJobsSnapshotScopeGuard(
  event: IpcMainInvokeEvent,
  window: BrowserWindow,
  readers: SnapshotScopeReaders
): () => boolean {
  const sender = event.sender
  const frame = event.senderFrame
  const documentUrl = frame?.url
  const documentEpoch = readers.documentEpoch(sender)
  const profilePath = readers.currentProfilePath()
  readers.refreshSettings()
  const settingsEpoch = readers.settingsEpoch()
  const authBoundaryIsCurrent = readers.captureAuthBoundary()

  return () => {
    readers.refreshSettings()
    return (
      readers.currentWindow() === window &&
      !window.isDestroyed() &&
      window.webContents === sender &&
      !sender.isDestroyed() &&
      event.sender === sender &&
      event.senderFrame === frame &&
      !!frame &&
      !frame.isDestroyed() &&
      frame.url === documentUrl &&
      sender.getURL() === documentUrl &&
      readers.documentEpoch(sender) === documentEpoch &&
      readers.currentProfilePath() === profilePath &&
      readers.settingsEpoch() === settingsEpoch &&
      authBoundaryIsCurrent()
    )
  }
}

export function captureImportJobsSnapshotScope(
  event: IpcMainInvokeEvent,
  currentWindow: () => BrowserWindow | null
): (() => boolean) | null {
  const window = currentWindow()
  if (!window) return null
  return createImportJobsSnapshotScopeGuard(event, window, {
    currentWindow,
    documentEpoch: (sender) => mainDocumentEpochs.get(sender) ?? 0,
    currentProfilePath: () => app.getPath('userData'),
    refreshSettings: getSettings,
    settingsEpoch: getSettingsObservationEpoch,
    captureAuthBoundary: captureAuthSessionBoundary
  })
}

const mainDocumentEpochs = new WeakMap<WebContents, number>()

export function trackMainDocument(
  webContents: WebContents,
  isCurrent: () => boolean,
  onNavigation: () => void
): () => number {
  mainDocumentEpochs.set(webContents, 0)
  webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (!isMainFrame || isInPlace) return
    mainDocumentEpochs.set(webContents, (mainDocumentEpochs.get(webContents) ?? 0) + 1)
    if (isCurrent()) onNavigation()
  })
  return () => mainDocumentEpochs.get(webContents) ?? 0
}

export function emptyImportJobsSnapshot(): SharedImportJobsSnapshot {
  return {
    jobs: [],
    policyBlocked: false,
    heldJobIds: [],
    policyHeldJobIds: [],
    inventoryOverflow: false,
    policyHoldOverflow: false
  }
}

export function createImportJobView(readJobs: () => ImportJob[]): (job: ImportJob) => ImportJobView {
  return (job) => {
    let pct: number | null = null
    if (job.state === 'done') pct = 100
    else if (job.progressPct !== undefined) pct = Math.min(99, Math.max(0, Math.round(job.progressPct)))
    else if (job.totalChunks > 0) pct = Math.min(99, Math.round((job.cursor / job.totalChunks) * 100))
    let queuePosition: number | undefined
    if (job.state === 'queued') {
      const waiting = readJobs()
        .filter((candidate) => candidate.state === 'queued')
        .sort((left, right) => left.createdAt - right.createdAt)
      const index = waiting.findIndex((candidate) => candidate.jobId === job.jobId)
      if (index >= 0) queuePosition = index + 1
    }
    return {
      jobId: job.jobId,
      title: job.title,
      state: job.state,
      cursor: job.cursor,
      totalChunks: job.totalChunks,
      pct,
      error: job.error,
      recapError: job.recapError,
      file: job.file,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      queuePosition
    }
  }
}

export async function listImportJobsSnapshot(
  event: IpcMainInvokeEvent,
  currentWindow: () => BrowserWindow | null,
  readSnapshot: () => Promise<ImportJobsSnapshot>,
  toView: (job: ImportJob) => ImportJobView
): Promise<SharedImportJobsSnapshot> {
  return readImportJobsSnapshot(
    requireAuth,
    () => captureImportJobsSnapshotScope(event, currentWindow),
    readSnapshot,
    toView
  )
}

export async function readImportJobsSnapshot(
  isAuthorized: () => boolean,
  captureScope: () => (() => boolean) | null,
  readSnapshot: () => Promise<ImportJobsSnapshot>,
  toView: (job: ImportJob) => ImportJobView
): Promise<SharedImportJobsSnapshot> {
  if (!isAuthorized()) return emptyImportJobsSnapshot()
  const scopeIsCurrent = captureScope()
  if (!scopeIsCurrent) return emptyImportJobsSnapshot()
  const snapshot = await readSnapshot()
  if (!scopeIsCurrent()) return emptyImportJobsSnapshot()
  return { ...snapshot, jobs: snapshot.jobs.map(toView) }
}
