/**
 * command-speech-panel-model.ts — what the Cmd+Shift+M voice command panel says and offers (G18).
 *
 * Pure. Every capture failure uses the one fixed message and the one recovery of the shared voice taxonomy
 * (`voice-turn.ts`), so the panel and a hold-to-talk turn never describe the same failure two ways. The panel keeps
 * only the copy for its own preconditions: the engine row, signed out, and the click-to-start rule.
 */
import type { CommandMicAvailabilityResult } from '@shared/ipc'
import { commandMicReasonToVoice, voiceReasonCopy, voiceReasonRecovery } from '@shared/voice/voice-turn'
import type { CommandMicStatus, CommandMicStopReason } from '../lib/use-command-mic'
import { openSettingsTitle } from '../lib/os-settings-copy'

export type CommandPanelRecovery =
  | { kind: 'open_settings'; label: 'Open System Settings' | 'Open Settings' }
  | { kind: 'try_again'; label: 'Try again' }

export interface CommandPanelView {
  message: string
  recovery: CommandPanelRecovery | null
  /** The Start button stays disabled while the engine, policy or sign-in blocks a capture. */
  unavailable: boolean
}

export function commandSpeechPanelView(input: {
  engineSelected: boolean
  availability: CommandMicAvailabilityResult | null
  status: CommandMicStatus
  reason?: CommandMicStopReason
  windows?: boolean
}): CommandPanelView {
  const { availability, status, reason } = input
  const policyBlocked =
    (availability?.ok === false && availability.reason === 'policy_blocked') || reason === 'policy_blocked'
  const unsupported =
    !input.engineSelected ||
    (availability?.ok === false && availability.reason === 'unsupported_engine') ||
    reason === 'unsupported_engine'
  const unavailable = policyBlocked || unsupported || !availability?.ok
  const view = (message: string, recovery: CommandPanelRecovery | null = null): CommandPanelView => ({
    message,
    recovery,
    unavailable
  })
  if (policyBlocked) return view(voiceReasonCopy('policy_blocked'))
  if (unsupported) return view('Local voice commands require Parakeet. Select Parakeet in Speech settings.')
  if (availability === null) return view('Checking voice command policy…')
  if (availability.ok === false && availability.reason === 'unauthorized') return view('Sign in to use voice commands.')
  if (status === 'starting') return view('Opening the microphone…')
  if (status === 'listening') return view('Listening. Speak one command, then stop.')
  if (status === 'finalizing') return view('Checking the command…')
  if (status === 'done') return view('Command sent for review.')
  if (status === 'error') {
    if (reason === 'activation_required') return view('Use the Start button to begin a voice command.')
    const voice = commandMicReasonToVoice(reason) ?? 'recognition_unavailable'
    const action = voiceReasonRecovery(voice)
    const recovery: CommandPanelRecovery | null =
      action === 'open_settings'
        ? { kind: 'open_settings', label: openSettingsTitle(input.windows) }
        : action === 'try_again'
          ? { kind: 'try_again', label: 'Try again' }
          : null
    return view(voiceReasonCopy(voice), recovery)
  }
  return view('Voice capture starts only when you press Start.')
}
