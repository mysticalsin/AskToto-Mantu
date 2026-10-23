import type { IpcRenderer } from 'electron'
import {
  IDLE_WALKTHROUGH_VIEW,
  WALKTHROUGH_IPC,
  WalkthroughActInputSchema,
  WalkthroughViewSchema,
  type WalkthroughCardAction,
  type WalkthroughView
} from '../shared/walkthrough-view'

type Unsub = () => void

/**
 * `window.toto.walkthrough` (G45): the coach card's view of the walkthrough and the owner's four actions. Pushed and
 * returned views are validated here; an invalid push is dropped, an invalid reply reads as idle. There is no call that
 * starts a walkthrough or supplies a goal: those are main's, from a spoken turn.
 */
export function createWalkthroughPreloadApi(ipc: Pick<IpcRenderer, 'on' | 'removeListener' | 'invoke'>): {
  walkthrough: {
    current(): Promise<WalkthroughView>
    act(action: WalkthroughCardAction): Promise<{ ok: boolean }>
    onView(listener: (view: WalkthroughView) => void): Unsub
  }
} {
  return {
    walkthrough: {
      async current() {
        const parsed = WalkthroughViewSchema.safeParse(await ipc.invoke(WALKTHROUGH_IPC.current))
        return parsed.success ? parsed.data : IDLE_WALKTHROUGH_VIEW
      },
      async act(action) {
        const input = WalkthroughActInputSchema.safeParse({ action })
        if (!input.success) return { ok: false }
        const raw: unknown = await ipc.invoke(WALKTHROUGH_IPC.act, input.data)
        return { ok: typeof raw === 'object' && raw !== null && (raw as { ok?: unknown }).ok === true }
      },
      onView(listener) {
        const handler = (_event: unknown, payload: unknown): void => {
          const parsed = WalkthroughViewSchema.safeParse(payload)
          if (!parsed.success) return
          try {
            listener(parsed.data)
          } catch {
            /* a throwing subscriber must not break the bridge */
          }
        }
        ipc.on(WALKTHROUGH_IPC.view, handler)
        return () => ipc.removeListener(WALKTHROUGH_IPC.view, handler)
      }
    }
  }
}
