import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import {
  IPC,
  LiveMeetingStartedAtSchema,
  DraftMeetingLifecyclePayloadSchema,
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
  preserveDraftTranscript?: (startedAt: number) => Promise<void>
  discardDraftTranscript?: (
    settings: Settings,
    startedAt: number,
    isCurrent?: () => boolean
  ) => Promise<{ ok: true } | { ok: false; error: string }>
}

/** Periodic best-effort snapshots retain the existing saved/failed/disabled renderer receipts. */
export function registerDraftTranscriptIpc(deps: DraftTranscriptIpcDependencies): void {
  deps.ipcMain.handle(IPC.saveDraftTranscript, async (event, raw): Promise<SaveDraftTranscriptResult> => {
    deps.assertMainWindow(event)
    if (!deps.requireAuth()) return { status: 'failed' }
    const authCurrent = deps.captureAuthSessionBoundary()
    const parsed = SaveMeetingSchema.safeParse(raw)
    if (!parsed.success) return { status: 'failed' }
    if (!LiveMeetingStartedAtSchema.safeParse(parsed.data.startedAt).success) return { status: 'failed' }
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

  if (deps.preserveDraftTranscript) {
    deps.ipcMain.handle(IPC.preserveDraftTranscript, async (event, raw): Promise<{ ok: boolean }> => {
      deps.assertMainWindow(event)
      if (!deps.requireAuth()) return { ok: false }
      const authCurrent = deps.captureAuthSessionBoundary()
      const parsed = DraftMeetingLifecyclePayloadSchema.safeParse(raw)
      if (!parsed.success || !authCurrent()) return { ok: false }
      await deps.preserveDraftTranscript!(parsed.data.startedAt)
      return { ok: authCurrent() }
    })
  }

  if (deps.discardDraftTranscript) {
    deps.ipcMain.handle(
      IPC.discardDraftTranscript,
      async (event, raw): Promise<{ ok: boolean; error?: string }> => {
        deps.assertMainWindow(event)
        if (!deps.requireAuth()) return { ok: false }
        const authCurrent = deps.captureAuthSessionBoundary()
        const parsed = DraftMeetingLifecyclePayloadSchema.safeParse(raw)
        if (!parsed.success || !authCurrent()) return { ok: false }
        const result = await deps.discardDraftTranscript!(deps.getSettings(), parsed.data.startedAt, authCurrent)
        if (!authCurrent()) return { ok: false }
        return result
      }
    )
  }
}
