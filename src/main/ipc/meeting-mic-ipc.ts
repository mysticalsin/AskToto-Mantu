import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { MeetingMicCaptureConfirmRequestSchema, MeetingMicCaptureReleaseRequestSchema } from '@shared/input-session'
import type { MeetingMicCaptureGrant } from '@shared/input-session'
import { IPC, MeetingMicAdmissionRequestSchema } from '@shared/ipc'
import type { MeetingMicCaptureAuthority, MeetingMicCaptureFrame } from '../meeting-mic-capture-authority'
import {
  MEETING_START_ACTION,
  type MeetingStartActivationAuthority,
  type MeetingStartActivationFrame
} from '../meeting-start-activation-authority'

export interface MeetingMicIpcDependencies {
  ipcMain: Pick<IpcMain, 'handle'>
  assertMainWindow: (event: IpcMainInvokeEvent) => void
  requireAuth: () => boolean
  /** True once input admission is closing for quit; no new capture or activation is admitted. */
  isInputClosing: () => boolean
  /** True only after the suspend and lock-screen revocation hooks are installed. */
  isCaptureLifecycleReady: () => boolean
  /** True when the main window exists, is not destroyed, and is visible. */
  isMainWindowVisible: () => boolean
  activationFrameFromEvent: (event: IpcMainInvokeEvent) => MeetingStartActivationFrame | null
  activation: Pick<MeetingStartActivationAuthority, 'mint' | 'hasPending' | 'revokeAll'>
  capture: Pick<MeetingMicCaptureAuthority, 'admit' | 'confirm' | 'release'>
}

function captureFrameFromEvent(event: IpcMainInvokeEvent): MeetingMicCaptureFrame | null {
  const frame = event.senderFrame
  if (!frame) return null
  return {
    webContentsId: event.sender.id,
    isTopFrame: frame.parent === null,
    url: frame.url
  }
}

/** Main-window meeting microphone admission and meeting-start activation handlers. */
export function registerMeetingMicIpc(deps: MeetingMicIpcDependencies): void {
  const activationAllowed = (): boolean => deps.requireAuth() && !deps.isInputClosing() && deps.isMainWindowVisible()

  deps.ipcMain.handle(IPC.meetingMicAdmission, (event, raw: unknown): MeetingMicCaptureGrant | null => {
    deps.assertMainWindow(event)
    const parsed = MeetingMicAdmissionRequestSchema.safeParse(raw)
    if (!parsed.success || deps.isInputClosing() || !deps.isCaptureLifecycleReady()) return null
    const frame = captureFrameFromEvent(event)
    if (!frame) return null
    return deps.capture.admit(frame, parsed.data.startedAt)
  })
  deps.ipcMain.handle(IPC.meetingStartActivationObserved, (event): boolean => {
    deps.assertMainWindow(event)
    if (!activationAllowed()) return false
    const frame = deps.activationFrameFromEvent(event)
    return frame ? deps.activation.mint(frame, MEETING_START_ACTION) : false
  })
  deps.ipcMain.handle(IPC.meetingStartActivationReady, (event): boolean => {
    deps.assertMainWindow(event)
    if (!activationAllowed()) return false
    const frame = deps.activationFrameFromEvent(event)
    return frame ? deps.activation.hasPending(frame) : false
  })
  deps.ipcMain.handle(IPC.meetingStartActivationCancel, (event): boolean => {
    deps.assertMainWindow(event)
    const frame = deps.activationFrameFromEvent(event)
    if (!frame) return false
    // Cancellation is owner/frame scoped by the surrounding main-window assertion and current top frame.
    if (!deps.activation.hasPending(frame)) return false
    deps.activation.revokeAll()
    return true
  })
  deps.ipcMain.handle(IPC.meetingMicCaptureConfirm, (event, raw: unknown): boolean => {
    deps.assertMainWindow(event)
    const parsed = MeetingMicCaptureConfirmRequestSchema.safeParse(raw)
    if (!parsed.success || deps.isInputClosing()) return false
    const frame = captureFrameFromEvent(event)
    if (!frame) return false
    return deps.capture.confirm(frame, parsed.data.captureId, parsed.data.startedAt)
  })
  deps.ipcMain.handle(IPC.meetingMicCaptureRelease, (event, raw: unknown): boolean => {
    deps.assertMainWindow(event)
    const parsed = MeetingMicCaptureReleaseRequestSchema.safeParse(raw)
    if (!parsed.success) return false
    // Release is exact sender-owned cleanup; it never consults or mutates the meeting reservation.
    return deps.capture.release(event.sender.id, parsed.data.captureId)
  })
}
