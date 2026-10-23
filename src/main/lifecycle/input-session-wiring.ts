/** Main-process composition for input-session lifecycle hooks shared by voice capture and G27 playback. */
import { IPC } from '@shared/ipc'
import type { InputSessionStopReason } from '@shared/input-session'
import type { CommandSpeechCapture } from '../command-speech-capture'
import { createCommandMicLeaseTimer } from '../command-mic-lease-timer'
import { InputSessionAuthority } from '../input-session-authority'
import type { VoiceActionsRuntime } from '../voice/voice-actions-runtime'

interface OwnerWindowLike {
  isDestroyed(): boolean
  webContents: { id: number; send(channel: string, payload: unknown): void }
}

export interface MainInputSessionWiringDeps {
  voiceActions(): Pick<VoiceActionsRuntime, 'onHardStop' | 'onMeetingReserved'> | null | undefined
  revokeSpokenReplies(): void
  commandMicActivationLeaseId(): string | null
  clearCommandMicActivationLeaseId(): void
  commandSpeechCapture(): Pick<CommandSpeechCapture, 'cancelForLease'> | null | undefined
  window(): OwnerWindowLike | null | undefined
}

/**
 * Creates the command-mic lease timer before its authority, as index.ts did inline. Getters stay live because the
 * authority can be constructed before voice actions and spoken replies are assigned.
 */
export function createMainInputSessionWiring(deps: MainInputSessionWiringDeps) {
  let authority!: InputSessionAuthority
  const leaseTimer = createCommandMicLeaseTimer({
    leaseId: deps.commandMicActivationLeaseId,
    authority: () => authority
  })
  authority = new InputSessionAuthority({
    onHardStop: (reason: InputSessionStopReason) => deps.voiceActions()?.onHardStop(reason),
    onMeetingReserved: () => deps.voiceActions()?.onMeetingReserved(),
    onRevoked: (owner, lease, reason) => {
      try {
        deps.revokeSpokenReplies()
      } catch {
        // The input lease stays revoked if playback cleanup fails.
      }
      if (deps.commandMicActivationLeaseId() === lease.sessionId) {
        leaseTimer.clear(lease.sessionId)
        deps.clearCommandMicActivationLeaseId()
      }
      deps.commandSpeechCapture()?.cancelForLease(lease.sessionId)
      const win = deps.window()
      if (!win || win.isDestroyed() || win.webContents.id !== owner.webContentsId) return
      try {
        win.webContents.send(IPC.inputSessionRevoked, {
          sessionId: lease.sessionId,
          revision: lease.revision,
          reason
        })
      } catch {
        // Authority remains revoked if the renderer disappeared.
      }
    }
  })
  return {
    inputSessionAuthority: authority,
    clearCommandMicLeaseTimer: leaseTimer.clear,
    armCommandMicLeaseTimeout: leaseTimer.arm
  }
}
