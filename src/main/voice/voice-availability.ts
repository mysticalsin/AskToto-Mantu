/**
 * Whether command speech (a voice turn, and the Cmd+Shift+M panel) may run, decoupled from the meeting engine.
 *
 * Today `commandMicAvailability` refuses unless `asrEngine === 'parakeet'`, so choosing Apple Speech for meetings
 * would silently kill voice actions. Voice actions always recognize with the bundled Parakeet, whatever engine a
 * meeting uses. The engine now matters only when it is not Parakeet: then the Parakeet model must be present.
 */
import type { CommandMicAvailabilityResult } from '@shared/command-speech'

export interface CommandSpeechAvailabilityInput {
  readonly authenticated: boolean
  /** False under a managed cloud-only profile that blocks local speech. */
  readonly localSpeechAllowed: boolean
  readonly asrEngine: string
  /** The cached, last-known presence of the Parakeet model files. */
  readonly parakeetPresent: boolean
}

export function commandSpeechAvailability(input: CommandSpeechAvailabilityInput): CommandMicAvailabilityResult {
  if (!input.authenticated) return { ok: false, reason: 'unauthorized' }
  if (!input.localSpeechAllowed) return { ok: false, reason: 'policy_blocked' }
  // The Parakeet engine is unchanged: its model is fetched on demand. Any other engine needs the model on disk.
  if (input.asrEngine === 'parakeet' || input.parakeetPresent) return { ok: true }
  return { ok: false, reason: 'unsupported_engine' }
}

/** A synchronous view of an async presence probe, so sync authority checks can read it. */
export function createParakeetPresence(probe: () => Promise<boolean>): {
  get(): boolean
  refresh(): Promise<boolean>
} {
  let present = false
  let inFlight: Promise<boolean> | null = null
  return {
    get: () => present,
    refresh: () => {
      inFlight ??= probe()
        .catch(() => false)
        .then((value) => {
          present = value
          return value
        })
        .finally(() => {
          inFlight = null
        })
      return inFlight
    }
  }
}
