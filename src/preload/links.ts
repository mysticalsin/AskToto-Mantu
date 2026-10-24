import type { IpcRenderer } from 'electron'
import { LINK_IPC } from '../shared/links'

/** `window.toto.onLinkOpenFailed` (G55): main says a clicked link did not open. The push carries no payload, never the URL. */
export function createLinksPreloadApi(ipc: Pick<IpcRenderer, 'on' | 'removeListener'>): {
  onLinkOpenFailed(listener: () => void): () => void
} {
  return {
    onLinkOpenFailed(listener) {
      const handler = (): void => {
        try {
          listener()
        } catch {
          /* a throwing subscriber must not break the bridge */
        }
      }
      ipc.on(LINK_IPC.openFailed, handler)
      return () => ipc.removeListener(LINK_IPC.openFailed, handler)
    }
  }
}
