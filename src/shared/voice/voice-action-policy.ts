/**
 * Voice action policy (V03), pure.
 *
 * `decideVoiceAction` answers one question: given how reversible an action is and how the turn began, does it
 * run now, wait for the confirmation card, or is it refused. `voiceImmediateRunAllowed` is the gate an immediate
 * run must also pass in main: the confirmation policy minus "the owner window is focused", replaced by "the
 * turn that produced this action has not been revoked".
 */
import type { VoiceActionClass } from './catalog'

/**
 * How the turn began. `push-to-talk` is the held chord (hardware activation minted in main). `panel` is the
 * trusted click in the command panel, which keeps its proposal-then-confirm behaviour. `wake` is the optional
 * on-device wake word (V07): a word alone never runs a desktop action.
 */
export type VoiceTurnSource = 'push-to-talk' | 'wake' | 'panel'
export type VoicePolicyDecision = 'run' | 'confirm' | 'refuse'

/** `null` class means the platform cannot run the action: it is refused, never guessed. */
export function decideVoiceAction(actionClass: VoiceActionClass | null, source: VoiceTurnSource): VoicePolicyDecision {
  if (actionClass === null) return 'refuse'
  if (source !== 'push-to-talk') return 'confirm'
  return actionClass === 'read' || actionClass === 'reversible' ? 'run' : 'confirm'
}

export interface VoiceImmediateRunInput {
  authenticated: boolean
  listenEntitled: boolean
  /** The owner window exists. Focus is deliberately not required: the hold did not take it. */
  ownerPresent: boolean
  ownerVisible: boolean
  onboardingExclusive: boolean
  lifecycleHooksReady: boolean
  /** A meeting is being recorded. No voice action runs while one is. */
  meetingReserved: boolean
  /** The turn has not been revoked since its hardware activation (sign-out, lock, suspend, meeting, reset). */
  turnCurrent: boolean
}

/** Missing trust or lifecycle state denies. Every field must be an explicit yes. */
export function voiceImmediateRunAllowed(input: VoiceImmediateRunInput): boolean {
  return (
    input.authenticated === true &&
    input.listenEntitled === true &&
    input.ownerPresent === true &&
    input.ownerVisible === true &&
    input.onboardingExclusive === false &&
    input.lifecycleHooksReady === true &&
    input.meetingReserved === false &&
    input.turnCurrent === true
  )
}
