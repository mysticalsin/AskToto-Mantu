import type { IpcRenderer } from 'electron'
import {
  SPOKEN_REPLIES_IPC,
  SpokenRepliesStateSchema,
  TtsVoiceListSchema,
  type PreviewRequest,
  type SpokenRepliesState,
  type TtsVoice
} from '../shared/spoken-replies'

type Unsub = () => void

/**
 * Spoken replies bridge (G27). Every push from main is validated here and a malformed payload is dropped. The
 * renderer can read the state and the approved voice list, play the fixed preview sentence with a voice and rate, and
 * stop playback. There is no call that takes text to speak.
 */
export function createSpokenRepliesPreloadApi(ipc: Pick<IpcRenderer, 'on' | 'removeListener' | 'invoke'>): {
  spokenReplies: {
    getState(): Promise<SpokenRepliesState | null>
    onState(cb: (state: SpokenRepliesState) => void): Unsub
    voices(): Promise<TtsVoice[]>
    preview(request: PreviewRequest): Promise<{ ok: boolean }>
    stop(): Promise<unknown>
  }
} {
  return {
    spokenReplies: {
      async getState() {
        const parsed = SpokenRepliesStateSchema.safeParse(await ipc.invoke(SPOKEN_REPLIES_IPC.getState))
        return parsed.success ? parsed.data : null
      },
      onState(cb) {
        const listener = (_event: unknown, payload: unknown): void => {
          const parsed = SpokenRepliesStateSchema.safeParse(payload)
          if (!parsed.success) return
          try {
            cb(parsed.data)
          } catch {
            /* a throwing subscriber must not break the bridge */
          }
        }
        ipc.on(SPOKEN_REPLIES_IPC.state, listener)
        return () => ipc.removeListener(SPOKEN_REPLIES_IPC.state, listener)
      },
      async voices() {
        const parsed = TtsVoiceListSchema.safeParse(await ipc.invoke(SPOKEN_REPLIES_IPC.voices))
        return parsed.success ? parsed.data : []
      },
      async preview(request) {
        const result: unknown = await ipc.invoke(SPOKEN_REPLIES_IPC.preview, request)
        return { ok: typeof result === 'object' && result !== null && (result as { ok?: unknown }).ok === true }
      },
      stop: () => ipc.invoke(SPOKEN_REPLIES_IPC.stop)
    }
  }
}
