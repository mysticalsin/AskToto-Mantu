/** Conversation IPC registration. Handler logic lives on the conversation runtime; this file owns channels and the sender gate. */
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { CONVERSATION_IPC } from '@shared/conversation/conversation-session'
import type { ConversationIpcHandlers } from '../features/conversation/conversation-runtime'

export interface ConversationIpcDeps {
  ipcMain: Pick<IpcMain, 'handle'>
  assertMainWindow(event: IpcMainInvokeEvent): void
  handlers: ConversationIpcHandlers
}

export function registerConversationIpc({ ipcMain, assertMainWindow, handlers }: ConversationIpcDeps): void {
  ipcMain.handle(CONVERSATION_IPC.startActivationObserved, (event) => {
    assertMainWindow(event)
    return handlers.startActivationObserved(event)
  })
  ipcMain.handle(CONVERSATION_IPC.startActivationCancel, (event) => {
    assertMainWindow(event)
    return handlers.startActivationCancel(event)
  })
  ipcMain.handle(CONVERSATION_IPC.start, (event) => {
    assertMainWindow(event)
    return handlers.start(event)
  })
  ipcMain.handle(CONVERSATION_IPC.stop, (event) => {
    assertMainWindow(event)
    return handlers.stop(event)
  })
  ipcMain.handle(CONVERSATION_IPC.getState, (event) => {
    assertMainWindow(event)
    return handlers.getState(event)
  })
  ipcMain.handle(CONVERSATION_IPC.captureStart, (event, raw: unknown) => {
    assertMainWindow(event)
    return handlers.captureStart(event, raw)
  })
  ipcMain.handle(CONVERSATION_IPC.captureFrame, (event, raw: unknown) => {
    assertMainWindow(event)
    return handlers.captureFrame(event, raw)
  })
  ipcMain.handle(CONVERSATION_IPC.captureFinish, async (event, raw: unknown) => {
    assertMainWindow(event)
    return handlers.captureFinish(event, raw)
  })
  ipcMain.handle(CONVERSATION_IPC.captureCancelRequest, (event, raw: unknown) => {
    assertMainWindow(event)
    return handlers.captureCancelRequest(event, raw)
  })
  ipcMain.handle(CONVERSATION_IPC.captureFailure, (event, raw: unknown) => {
    assertMainWindow(event)
    return handlers.captureFailure(event, raw)
  })
  ipcMain.handle(CONVERSATION_IPC.replyFinished, (event, raw: unknown) => {
    assertMainWindow(event)
    return handlers.replyFinished(event, raw)
  })
}
