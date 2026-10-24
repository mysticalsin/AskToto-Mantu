import type { IpcRenderer } from 'electron'
import { DICTATION_STATUS_IPC, DictationStatusSchema, type DictationStatus } from '../shared/dictation-status'

type Unsub = () => void

/**
 * Dictation status bridge (G30). Read-only: the renderer can read the status and subscribe to changes, nothing more.
 * Every payload is validated against the strict schema and a malformed one is dropped. A status older than one
 * already delivered is dropped too, so a late reply cannot move the pill backwards.
 */
export function createDictationStatusPreloadApi(ipc: Pick<IpcRenderer, 'on' | 'removeListener' | 'invoke'>): {
  dictationStatus: {
    getState(): Promise<DictationStatus | null>
    onState(cb: (status: DictationStatus) => void): Unsub
  }
} {
  let highest = -1
  const accept = (raw: unknown): DictationStatus | null => {
    const parsed = DictationStatusSchema.safeParse(raw)
    if (!parsed.success || parsed.data.revision < highest) return null
    highest = parsed.data.revision
    return parsed.data
  }
  return {
    dictationStatus: {
      async getState() {
        return accept(await ipc.invoke(DICTATION_STATUS_IPC.getState))
      },
      onState(cb) {
        const listener = (_event: unknown, payload: unknown): void => {
          const status = accept(payload)
          if (!status) return
          try {
            cb(status)
          } catch {
            /* a throwing subscriber must not break the bridge */
          }
        }
        ipc.on(DICTATION_STATUS_IPC.state, listener)
        return () => ipc.removeListener(DICTATION_STATUS_IPC.state, listener)
      }
    }
  }
}
