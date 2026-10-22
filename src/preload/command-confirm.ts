import type { IpcRenderer } from 'electron'
import {
  COMMAND_CONFIRM_IPC,
  MetisCommandNoticeSchema,
  MetisCommandRecoveryNoticeSchema,
  type MetisCommandNotice,
  type MetisCommandRecoveryNotice
} from '../shared/metis-command-contract'

type Unsub = () => void

/**
 * The confirmation card's extras: honest copy for a command that could not start, and the once-only boot recovery
 * notices. Every push from main is validated here and a malformed payload is dropped. Confirming and cancelling
 * stay on the existing `confirmMetisCommand` / `cancelMetisCommand` bridge, which main validates again.
 */
export function createCommandConfirmPreloadApi(ipc: Pick<IpcRenderer, 'on' | 'removeListener' | 'invoke'>): {
  onMetisCommandNotice(cb: (notice: MetisCommandNotice) => void): Unsub
  takeMetisCommandRecoveryNotices(): Promise<MetisCommandRecoveryNotice[]>
} {
  return {
    onMetisCommandNotice(cb) {
      const listener = (_event: unknown, payload: unknown): void => {
        const parsed = MetisCommandNoticeSchema.safeParse(payload)
        if (!parsed.success) return
        try {
          cb(parsed.data)
        } catch {
          /* a throwing subscriber must not break the bridge */
        }
      }
      ipc.on(COMMAND_CONFIRM_IPC.notice, listener)
      return () => ipc.removeListener(COMMAND_CONFIRM_IPC.notice, listener)
    },
    async takeMetisCommandRecoveryNotices() {
      const raw: unknown = await ipc.invoke(COMMAND_CONFIRM_IPC.recoveryNotices)
      if (!Array.isArray(raw)) return []
      return raw.flatMap((item) => {
        const parsed = MetisCommandRecoveryNoticeSchema.safeParse(item)
        return parsed.success ? [parsed.data] : []
      })
    }
  }
}
