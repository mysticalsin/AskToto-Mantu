import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { TASK_CARD_IPC, TaskCardIdInputSchema, type TaskCardView } from '@shared/task-card'

/** What the IPC layer needs from the task bridge. Owners are `webContents:<id>`, the string the bridge schedules with. */
export interface TaskCardRuntime {
  cards(owner: string): TaskCardView[]
  stopCard(owner: string, cardId: string): boolean
  dismissCard(owner: string, cardId: string): boolean
  onCardsChanged(listener: () => void): () => void
}

const ownerOf = (webContentsId: number): string => `webContents:${webContentsId}`

/**
 * Task cards for the sidecar (G33). Every handler sits behind the main-window sender check and acts only on the
 * calling window's own cards; stop and dismiss take an opaque card id. The list is pushed to the owner window
 * whenever it changes. Returns a disposer that stops the push.
 */
export function registerTaskCardIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  assertMainWindow: (event: IpcMainInvokeEvent) => void,
  runtime: TaskCardRuntime,
  getWindow: () => Pick<BrowserWindow, 'isDestroyed' | 'webContents'> | null
): () => void {
  ipcMain.handle(TASK_CARD_IPC.list, (event) => {
    assertMainWindow(event)
    return runtime.cards(ownerOf(event.sender.id))
  })
  ipcMain.handle(TASK_CARD_IPC.stop, (event, raw: unknown) => {
    assertMainWindow(event)
    const parsed = TaskCardIdInputSchema.safeParse(raw)
    return { ok: parsed.success && runtime.stopCard(ownerOf(event.sender.id), parsed.data.cardId) }
  })
  ipcMain.handle(TASK_CARD_IPC.dismiss, (event, raw: unknown) => {
    assertMainWindow(event)
    const parsed = TaskCardIdInputSchema.safeParse(raw)
    return { ok: parsed.success && runtime.dismissCard(ownerOf(event.sender.id), parsed.data.cardId) }
  })
  return runtime.onCardsChanged(() => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    win.webContents.send(TASK_CARD_IPC.cards, runtime.cards(ownerOf(win.webContents.id)))
  })
}
