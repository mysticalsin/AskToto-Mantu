import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { registerWalkthroughIpc, type WalkthroughIpcSurface } from './walkthrough-ipc'
import { DICTATION_STATUS_IPC, type DictationStatus } from '@shared/dictation-status'
import { VOICE_ACTIONS_IPC, type VoiceStateSnapshot } from '@shared/voice/voice-turn'

interface VoiceActionsIpcRuntime {
  snapshot(): VoiceStateSnapshot
  report(raw: unknown): { ok: boolean }
  setChordRecorderActive(raw: unknown): { ok: boolean }
  /** G30: the read-only dictation status for the activity pill. */
  dictationStatus?(): DictationStatus
  walkthrough?: WalkthroughIpcSurface | null
}

/**
 * Voice actions renderer IPC: the current state, the capture report and the chord recorder flag. All sit behind the
 * main-window sender check. There is deliberately no handler that starts a turn, mints an activation or opens a
 * microphone; those are main's, from the held chord. The recorder flag can only pause the hold.
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
  ipcMain.handle(VOICE_ACTIONS_IPC.recorder, (event, raw: unknown) => {
    assertMainWindow(event)
    return runtime.setChordRecorderActive(raw)
  })
  if (runtime.dictationStatus) {
    const status = runtime.dictationStatus.bind(runtime)
    ipcMain.handle(DICTATION_STATUS_IPC.getState, (event) => {
      assertMainWindow(event)
      return status()
    })
  }
  if (runtime.walkthrough) registerWalkthroughIpc(ipcMain, assertMainWindow, runtime.walkthrough)
}
