import type { IpcRenderer } from 'electron'
import { QUIET_IPC } from '../shared/quiet-ipc'
import type { QuietAction, QuietDeferredBatch, QuietOutputChannel, QuietPolicy } from '../shared/quiet-mode-settings'

type Unsub = () => void

/** Quiet-mode bridge (G68): read the policy, offer one unsolicited output for gating, hear a coalesced release. */
export function createQuietPreloadApi(ipc: Pick<IpcRenderer, 'on' | 'removeListener' | 'invoke'>): {
  getQuietPolicy(): Promise<QuietPolicy>
  quietOutputOffer(channel: QuietOutputChannel): Promise<QuietAction>
  onQuietOutputReleased(cb: (batch: QuietDeferredBatch) => void): Unsub
} {
  return {
    getQuietPolicy: () => ipc.invoke(QUIET_IPC.policyGet),
    quietOutputOffer: (channel) => ipc.invoke(QUIET_IPC.outputOffer, channel),
    onQuietOutputReleased: (cb) => {
      const handler = (_e: unknown, batch: QuietDeferredBatch): void => cb(batch)
      ipc.on(QUIET_IPC.outputReleased, handler)
      return () => ipc.removeListener(QUIET_IPC.outputReleased, handler)
    }
  }
}
