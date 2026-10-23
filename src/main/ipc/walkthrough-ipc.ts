import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import {
  WALKTHROUGH_IPC,
  WalkthroughActInputSchema,
  WalkthroughViewSchema,
  type WalkthroughView
} from '@shared/walkthrough-view'
import type { WalkthroughIntent } from '../features/walkthrough/walkthrough-intent'

/** What the renderer bridge may reach of the G44 runtime: the view, the feature switch and the owner's four actions. */
export interface WalkthroughIpcSurface {
  enabled(): boolean
  view(): WalkthroughView
  handle(intent: WalkthroughIntent): Promise<{ status: string }>
}

const REFUSED = new Set(['disabled', 'no_owner', 'ignored'])

/**
 * Walkthrough renderer IPC (G45): the current view and the owner's own check, pause, resume and stop. Both sit behind
 * the main-window sender check. There is no call that starts a walkthrough, supplies a goal or a plan: a start is only
 * ever a spoken turn in main. With the feature off (the release default) an action is refused and does nothing.
 */
export function registerWalkthroughIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  assertMainWindow: (event: IpcMainInvokeEvent) => void,
  surface: WalkthroughIpcSurface
): void {
  ipcMain.handle(WALKTHROUGH_IPC.current, (event) => {
    assertMainWindow(event)
    return surface.view()
  })
  ipcMain.handle(WALKTHROUGH_IPC.act, async (event, raw: unknown) => {
    assertMainWindow(event)
    const input = WalkthroughActInputSchema.safeParse(raw)
    if (!input.success || !surface.enabled()) return { ok: false }
    try {
      const result = await surface.handle({ kind: input.data.action })
      return { ok: !REFUSED.has(result.status) }
    } catch {
      return { ok: false }
    }
  })
}

interface OwnerWindow {
  isDestroyed(): boolean
  webContents: { id?: number; send(channel: string, payload: unknown): void }
}

/**
 * Pushes each view change to the live owner window only: the window whose web contents is the owner the voice turns
 * use. Another window, a destroyed one or an unknown owner gets nothing. The view is validated before it leaves main.
 */
export function createWalkthroughOwnerPush(deps: {
  window(): OwnerWindow | null | undefined
  ownerWebContentsId(): number | null
}): (view: WalkthroughView) => void {
  return (view) => {
    const parsed = WalkthroughViewSchema.safeParse(view)
    if (!parsed.success) return
    const owner = deps.ownerWebContentsId()
    const win = deps.window()
    if (typeof owner !== 'number' || !win || win.isDestroyed() || win.webContents.id !== owner) return
    win.webContents.send(WALKTHROUGH_IPC.view, parsed.data)
  }
}
