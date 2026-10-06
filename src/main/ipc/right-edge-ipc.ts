/**
 * right-edge-ipc.ts — IPC.rightEdgeState (M2-0202, spec v3 §4): the page reports the surface it renders, its
 * content height and its pins; the reply is main's current surface. A malformed report is dropped and still
 * answered, so the page never renders a placement main did not resolve. A reporting page that reloads,
 * navigates or crashes takes its pins with it: a stale pin never holds the surface open.
 */
import { ipcMain, screen, type WebContents } from 'electron'
import { IPC } from '@shared/ipc'
import { RightEdgeStateSchema, type RightEdgeSurfaceState } from '@shared/right-edge-state'
import type { RightEdgeSession } from '../island/right-edge-session'

type AssertMainWindow = (event: Electron.IpcMainInvokeEvent) => void

export function registerRightEdgeIpc(
  assertMainWindow: AssertMainWindow,
  session: RightEdgeSession,
  current: () => RightEdgeSurfaceState
): void {
  const watched = new WeakSet<WebContents>()
  // The page whose report the session holds; a replaced window's teardown never clears its successor's pins.
  let owner: WebContents | null = null
  ipcMain.handle(IPC.rightEdgeState, (e, raw: unknown): RightEdgeSurfaceState => {
    assertMainWindow(e)
    const sender = e.sender
    if (!watched.has(sender)) {
      watched.add(sender)
      const reset = (): void => {
        if (owner === sender) session.reset()
      }
      sender.on('did-start-loading', reset)
      sender.on('render-process-gone', reset)
      sender.once('destroyed', reset)
    }
    owner = sender
    const parsed = RightEdgeStateSchema.safeParse(raw)
    return parsed.success ? session.report(parsed.data) : current()
  })
  // A display change can move the edge class, H_max or the RE-G09 fallback. Re-read the surface once the
  // window has re-anchored (registerScreenListeners runs in the same event dispatch).
  const push = (): void => {
    setImmediate(() => session.push())
  }
  screen.on('display-added', push)
  screen.on('display-removed', push)
  screen.on('display-metrics-changed', push)
}
