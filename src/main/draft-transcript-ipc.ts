import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import {
  IPC,
  SaveMeetingSchema,
  stripProvisionalLines,
  type SaveDraftTranscriptResult,
  type SaveMeeting,
  type Settings
} from '@shared/ipc'

interface DraftTranscriptIpcDependencies {
  ipcMain: Pick<IpcMain, 'handle'>
  assertMainWindow: (event: IpcMainInvokeEvent) => void
  requireAuth: () => boolean
  captureAuthSessionBoundary: () => () => boolean
  getSettings: () => Settings
  captureDraftSettingsBoundary: () => () => boolean
  saveDraftTranscript: (
    settings: Settings,
    meeting: SaveMeeting,
    beforeReplace?: () => void
  ) => Promise<SaveDraftTranscriptResult>
}

/** Periodic best-effort snapshots retain the existing saved/failed/disabled renderer receipts. */
export function registerDraftTranscriptIpc(deps: DraftTranscriptIpcDependencies): void {
  deps.ipcMain.handle(IPC.saveDraftTranscript, async (event, raw): Promise<SaveDraftTranscriptResult> => {
    deps.assertMainWindow(event)
    if (!deps.requireAuth()) return { status: 'failed' }
    const authCurrent = deps.captureAuthSessionBoundary()
    const parsed = SaveMeetingSchema.safeParse(raw)
    if (!parsed.success) return { status: 'failed' }
    const settings = deps.getSettings()
    const settingsCurrent = deps.captureDraftSettingsBoundary()
    const admissionRefused = Symbol('draft authority changed')
    try {
      return await deps.saveDraftTranscript(
        settings,
        // UI-only provisional speech must never appear in a recovered draft.
        { ...parsed.data, lines: stripProvisionalLines(parsed.data.lines) },
        () => {
          // Authorization may synchronously publish settings; check their generation afterward.
          if (!authCurrent() || !settingsCurrent()) throw admissionRefused
        }
      )
    } catch (error) {
      if (error === admissionRefused) return { status: 'failed' }
      throw error
    }
  })
}
