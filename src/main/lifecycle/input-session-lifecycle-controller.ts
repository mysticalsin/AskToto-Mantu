import type { InputSessionStopReason } from '@shared/input-session'
import type { InputSessionAuthority } from '../input-session-authority'
import type { MeetingMicCaptureAuthority } from '../meeting-mic-capture-authority'
import type { MeetingStartActivationAuthority } from '../meeting-start-activation-authority'

interface InputSessionLifecycleWindow {
  isDestroyed(): boolean
  webContents: {
    id: number
    send(channel: string, payload: { startedAt: number; reason: InputSessionStopReason }): void
  }
}

export interface InputSessionLifecycleControllerDependencies {
  inputSessionAuthority: Pick<
    InputSessionAuthority,
    'hardStop' | 'hasMeetingReservation' | 'meetingStartedAt' | 'releaseMeeting'
  >
  meetingStartActivationAuthority: Pick<MeetingStartActivationAuthority, 'revokeAll'>
  meetingMicCaptureAuthority: Pick<MeetingMicCaptureAuthority, 'revokeMeeting'>
  meetingMicCaptureRevokedChannel: string
  incrementInputSessionContextRevision(): void
  getWindow(): InputSessionLifecycleWindow | null
  getMeetingCaptureOwnerWebContentsId(): number | null
  setMeetingCaptureOwnerWebContentsId(id: number | null): void
  getActiveLiveSpeakerStartedAt(): number | null
  setActiveLiveSpeakerStartedAt(startedAt: number | null): void
  discardActiveLiveSpeakerSession(): void
  closeLiveSpeakerReceipt(startedAt: number): void
  setLegacyListeningActive(on: boolean): void
  setListeningActive(on: boolean): void
  setTrayRecording(on: boolean): void
  setRecordingPowerSaveBlock(on: boolean): void
  parakeetRelease(): Promise<unknown>
  releaseSpeakerEmbedding(owner: 'live'): Promise<unknown>
}

export class InputSessionLifecycleController {
  constructor(private readonly deps: InputSessionLifecycleControllerDependencies) {}

  installInputPowerLifecycleHooks(
    register: (event: 'suspend' | 'lock-screen', callback: () => void) => void,
    setReady: (ready: boolean) => void,
    logger: { error(message: string, error?: unknown): void }
  ): boolean {
    let suspendRegistered = false
    let lockScreenRegistered = false
    try {
      register('suspend', () => this.hardStopInputSession('system-suspend'))
      suspendRegistered = true
    } catch (error) {
      logger.error('[input-session] microphone suspend revocation hook failed:', error)
    }
    try {
      register('lock-screen', () => this.hardStopInputSession('screen-locked'))
      lockScreenRegistered = true
    } catch (error) {
      logger.error('[input-session] microphone lock-screen revocation hook failed:', error)
    }
    const ready = suspendRegistered && lockScreenRegistered
    setReady(ready)
    if (!ready) logger.error('[input-session] microphone admission disabled: OS lifecycle hooks are incomplete')
    return ready
  }

  hardStopInputSession(reason: InputSessionStopReason): void {
    this.deps.meetingStartActivationAuthority.revokeAll()
    this.deps.incrementInputSessionContextRevision()
    this.deps.inputSessionAuthority.hardStop(reason)
    if (
      reason === 'auth-revoked' ||
      reason === 'sign-out' ||
      reason === 'owner-replaced' ||
      reason === 'system-suspend' ||
      reason === 'screen-locked' ||
      reason === 'shutdown'
    ) {
      this.hardStopMeetingCapture(reason)
    }
  }

  hardStopMeetingCapture(reason: InputSessionStopReason, speakerDisposition: 'close' | 'discard' = 'close'): void {
    const { deps } = this
    if (!deps.inputSessionAuthority.hasMeetingReservation) return
    const startedAt = deps.inputSessionAuthority.meetingStartedAt
    const ownerWebContentsId = deps.getMeetingCaptureOwnerWebContentsId()
    const win = deps.getWindow()
    if (
      startedAt !== null &&
      ownerWebContentsId !== null &&
      win &&
      !win.isDestroyed() &&
      win.webContents.id === ownerWebContentsId
    ) {
      try {
        win.webContents.send(deps.meetingMicCaptureRevokedChannel, { startedAt, reason })
      } catch {
        /* the owning renderer may already be gone */
      }
    }
    deps.meetingMicCaptureAuthority.revokeMeeting(startedAt, reason)
    if (speakerDisposition === 'discard' && startedAt !== null && deps.getActiveLiveSpeakerStartedAt() === startedAt) {
      // Discard releases this exact reservation itself. Continue all teardown below; an early return here
      // would leave native capture and the tray/power indicators running after the renderer died.
      deps.discardActiveLiveSpeakerSession()
    } else {
      deps.inputSessionAuthority.releaseMeeting(startedAt)
      if (startedAt !== null && deps.getActiveLiveSpeakerStartedAt() === startedAt) {
        deps.closeLiveSpeakerReceipt(startedAt)
        deps.setActiveLiveSpeakerStartedAt(null)
      }
    }
    deps.incrementInputSessionContextRevision()
    deps.setMeetingCaptureOwnerWebContentsId(null)
    deps.setLegacyListeningActive(false)
    deps.setListeningActive(false)
    deps.setTrayRecording(false)
    deps.setRecordingPowerSaveBlock(false)
    void deps.parakeetRelease().catch(() => {})
    void deps.releaseSpeakerEmbedding('live').catch(() => {})
  }
}
