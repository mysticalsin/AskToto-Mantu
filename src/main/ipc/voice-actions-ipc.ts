import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { VOICE_ACTIONS_IPC, type VoiceStateSnapshot } from '@shared/voice/voice-turn'

interface VoiceActionsIpcRuntime {
  snapshot(): VoiceStateSnapshot
  report(raw: unknown): { ok: boolean }
}

/**
 * Voice actions renderer IPC: the current state and the capture report. Both sit behind the main-window sender
 * check. There is deliberately no handler that starts a turn, mints an activation or opens a microphone; those
 * are main's, from the held chord.
 */
export function registerVoiceActionsIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  assertMainWindow: (event: IpcMainInvokeEvent) => void,
  runtime: VoiceActionsIpcRuntime
): void {
  ipcMain.handle(VOICE_ACTIONS_IPC.getState, (event) => {
    assertMainWindow(event)
    return runtime.snapshot()
  })
  ipcMain.handle(VOICE_ACTIONS_IPC.report, (event, raw: unknown) => {
    assertMainWindow(event)
    return runtime.report(raw)
  })
}
