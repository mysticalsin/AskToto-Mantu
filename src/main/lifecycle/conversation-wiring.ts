/** G28 composition: builds the conversation runtime from main's existing bundles and hands index.ts one handle. */
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { AskStart } from '@shared/ipc'
import { isSpeechCapturePurpose, type InputSessionContext } from '@shared/input-session'
import type { CommandMicAvailabilityResult } from '@shared/command-speech'
import type { InputSessionAuthority } from '../input-session-authority'
import { commandMicOwner } from '../command-mic-activation-authority'
import type { MeetingStartActivationFrame } from '../meeting-start-activation-authority'
import { createConversationRuntime, type ConversationRuntimeDeps } from '../features/conversation/conversation-runtime'
import { fanOutAskObservers } from '../features/session-context/ask-observers'
import { registerConversationIpc } from '../ipc/conversation-ipc'
import type { ReplyLifecycleEvent } from '../features/spoken-replies'
import type { AskTurnObservation } from '../features/session-context'

type FrameWindow = {
  isDestroyed(): boolean
  webContents: { id: number; mainFrame: { processId: number; routingId: number; parent: unknown; url: string } | null }
}

/** The main window's top frame as an activation frame; null while there is no live window. */
export function mainActivationFrame(
  window: () => FrameWindow | null | undefined
): () => MeetingStartActivationFrame | null {
  return () => {
    const win = window()
    if (!win || win.isDestroyed()) return null
    const frame = win.webContents.mainFrame
    if (!frame) return null
    return {
      webContentsId: win.webContents.id,
      frameId: `${frame.processId}:${frame.routingId}`,
      isTopFrame: frame.parent === null,
      url: frame.url
    }
  }
}

export function activationFrameFromEvent(event: IpcMainInvokeEvent): MeetingStartActivationFrame | null {
  const frame = event.senderFrame
  if (!frame) return null
  return {
    webContentsId: event.sender.id,
    frameId: `${frame.processId}:${frame.routingId}`,
    isTopFrame: frame.parent === null,
    url: frame.url
  }
}

/** A speech lease is current only while mic availability holds; a lost availability hard-stops that lease. */
export function commandLeaseGuard(
  availability: () => CommandMicAvailabilityResult,
  authority: InputSessionAuthority
): (sessionId: string) => boolean {
  return (sessionId) => {
    const current = availability()
    if (!current.ok) {
      const active = authority.activeLease
      if (isSpeechCapturePurpose(active?.purpose) && active?.sessionId === sessionId) {
        authority.hardStop(current.reason === 'unauthorized' ? 'sign-out' : 'cancelled')
      }
      return false
    }
    const active = authority.activeLease
    return active?.sessionId === sessionId && isSpeechCapturePurpose(active.purpose)
  }
}

/** Resolves the trusted owner of a command-speech IPC call, or null when the sender is not the live main frame. */
export function commandSpeechOwnerResolver(deps: {
  authority: InputSessionAuthority
  currentContext(): InputSessionContext
  requireAuth(): boolean
  mainFrame(): MeetingStartActivationFrame | null
  windowUrl(): string
}): (event: IpcMainInvokeEvent) => ReturnType<typeof commandMicOwner> {
  return (event) => {
    deps.authority.reconcileContext(deps.currentContext())
    if (!deps.requireAuth()) {
      deps.authority.hardStop('sign-out')
      return null
    }
    const frame = activationFrameFromEvent(event)
    const currentFrame = deps.mainFrame()
    if (
      !frame ||
      !currentFrame ||
      frame.webContentsId !== currentFrame.webContentsId ||
      frame.frameId !== currentFrame.frameId ||
      frame.url !== currentFrame.url ||
      frame.url !== deps.windowUrl()
    )
      return null
    return commandMicOwner(frame, deps.currentContext())
  }
}

export type ConversationWiringDeps = Omit<ConversationRuntimeDeps, 'cancelAsk'>

/** Late-bound: the runtime needs the input-session authority, which in turn needs this handle for its hooks. */
export function createConversationWiring() {
  let runtime: ReturnType<typeof createConversationRuntime> | null = null
  let askTurns: { cancel(id: string): void } | null = null
  return {
    get runtime() {
      return runtime
    },
    init(deps: ConversationWiringDeps): void {
      runtime = createConversationRuntime({ ...deps, cancelAsk: (id) => askTurns?.cancel(id) })
    },
    bindAskTurns(turns: { cancel(id: string): void }): void {
      askTurns = turns
    },
    onReplyLifecycle: (event: ReplyLifecycleEvent): void => runtime?.onReplyLifecycle(event),
    refresh: (): void => runtime?.refresh(),
    failAsk: (id: string): void => runtime?.failAsk(id),
    authorizeAsk: (event: IpcMainInvokeEvent, req: AskStart): boolean => runtime?.authorizeAsk(event, req) === true,
    observeAsk: (spoken: (event: AskTurnObservation) => void) =>
      fanOutAskObservers(spoken, (event) => runtime?.observeAsk(event)),
    registerIpc(ipcMain: Pick<IpcMain, 'handle'>, assertMainWindow: (event: IpcMainInvokeEvent) => void): void {
      if (runtime) registerConversationIpc({ ipcMain, assertMainWindow, handlers: runtime.handlers })
    }
  }
}
