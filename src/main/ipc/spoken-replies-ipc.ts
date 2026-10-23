import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import {
  PreviewRequestSchema,
  SPOKEN_REPLIES_IPC,
  type PreviewRequest,
  type SpokenRepliesState,
  type TtsVoice
} from '@shared/spoken-replies'

interface SpokenRepliesIpcRuntime {
  snapshot(): SpokenRepliesState
  listVoices(): Promise<TtsVoice[]>
  preview(request: PreviewRequest): Promise<{ ok: boolean }>
  stop(): void
}

/**
 * Spoken replies renderer IPC (G27): the state, the approved voice list, a preview and a stop. All sit behind the
 * main-window sender check. There is deliberately no handler that takes text to speak: the only sentence the renderer
 * can cause to be spoken is the fixed preview sentence, and replies are spoken from main's own view of the ask.
 */
export function registerSpokenRepliesIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  assertMainWindow: (event: IpcMainInvokeEvent) => void,
  runtime: SpokenRepliesIpcRuntime
): void {
  ipcMain.handle(SPOKEN_REPLIES_IPC.getState, (event) => {
    assertMainWindow(event)
    return runtime.snapshot()
  })
  ipcMain.handle(SPOKEN_REPLIES_IPC.voices, (event) => {
    assertMainWindow(event)
    return runtime.listVoices()
  })
  ipcMain.handle(SPOKEN_REPLIES_IPC.preview, (event, raw: unknown) => {
    assertMainWindow(event)
    const request = PreviewRequestSchema.safeParse(raw ?? {})
    if (!request.success) return Promise.resolve({ ok: false })
    return runtime.preview(request.data).then((result) => ({ ok: result.ok }))
  })
  ipcMain.handle(SPOKEN_REPLIES_IPC.stop, (event) => {
    assertMainWindow(event)
    runtime.stop()
  })
}
