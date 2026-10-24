import type { QuietMode } from '@shared/quiet-mode-settings'
import {
  QUIET_OUTPUT_CHANNELS,
  type QuietAction,
  type QuietDeferredBatch,
  type QuietOutputChannel,
  type QuietPolicy
} from '@shared/quiet-mode-settings'

export type { QuietAction, QuietDeferredBatch, QuietOutputChannel, QuietPolicy } from '@shared/quiet-mode-settings'
export type QuietFocusSignal = 'active' | 'inactive' | 'unknown'

export interface QuietPolicyInput {
  quietMode: QuietMode
  /** Main's accepted meeting reservation is the existing in-call signal. */
  inCall: boolean
  /** A present but unreadable signal is handled conservatively; an absent signal carries the stated assumption. */
  screenShare: { available: boolean; state: 'sharing' | 'not-sharing' | 'unknown' }
  /** Text and voice are independent so OS Focus can quiet them separately. */
  focus: { voice: QuietFocusSignal; text: QuietFocusSignal }
}

const ALL_QUIET: QuietPolicy = {
  toast: 'defer',
  sound: 'drop',
  spokenReply: 'drop',
  proactiveSuggestion: 'defer',
  autoAnswerCard: 'defer'
}

/** Pure policy: direct owner requests bypass this result at the output gate. */
export function evaluateQuietPolicy(input: QuietPolicyInput): QuietPolicy {
  // ASSUMED: an unavailable OS Focus reader cannot be used as a quiet signal; only a readable active state suppresses.
  const shareActive = input.screenShare.available && input.screenShare.state !== 'not-sharing'
  const callOrShare = input.inCall || shareActive
  if (input.quietMode === 'always' || (input.quietMode === 'calls-and-screen-sharing' && callOrShare)) {
    return { ...ALL_QUIET }
  }

  const quietText = input.focus.text === 'active'
  const quietVoice = input.focus.voice === 'active'
  return {
    toast: quietText ? 'defer' : 'allow',
    sound: quietVoice ? 'drop' : 'allow',
    spokenReply: quietVoice ? 'drop' : 'allow',
    proactiveSuggestion: quietText ? 'defer' : 'allow',
    autoAnswerCard: quietText ? 'defer' : 'allow'
  }
}

export interface QuietOutputGate {
  /** Send a direct owner response or apply the current unsolicited-output decision. */
  offer(channel: QuietOutputChannel, input: QuietPolicyInput, directRequest: boolean, deliver: () => void): QuietAction
  /** Observe call/settings/OS signals and release one coalesced deferred batch on quiet exit. */
  refresh(input: QuietPolicyInput): void
}

export function createQuietOutputGate(options: {
  now: () => number
  onReleased: (batch: QuietDeferredBatch) => void
}): QuietOutputGate {
  let wasQuiet = false
  let pendingSince: number | null = null
  const pending = new Set<QuietOutputChannel>()

  const refresh = (input: QuietPolicyInput): void => {
    const policy = evaluateQuietPolicy(input)
    const isQuiet = QUIET_OUTPUT_CHANNELS.some((channel) => policy[channel] !== 'allow')
    if (wasQuiet && !isQuiet && pending.size > 0) {
      const channels = QUIET_OUTPUT_CHANNELS.filter((channel) => pending.has(channel))
      const startedAtMs = pendingSince ?? options.now()
      pending.clear()
      pendingSince = null
      options.onReleased({ channels, startedAtMs, releasedAtMs: options.now() })
    }
    wasQuiet = isQuiet
  }

  return {
    offer(channel, input, directRequest, deliver) {
      refresh(input)
      if (directRequest) {
        deliver()
        return 'allow'
      }
      const action = evaluateQuietPolicy(input)[channel]
      if (action === 'allow') deliver()
      else if (action === 'defer') {
        if (pending.size === 0) pendingSince = options.now()
        pending.add(channel)
      }
      return action
    },
    refresh
  }
}

/** Electron has no supported cross-app macOS Focus reader in this app; UNKNOWN is the typed seam. */
export function readOsFocusSignal(): { voice: QuietFocusSignal; text: QuietFocusSignal } {
  return { voice: 'unknown', text: 'unknown' }
}

/** No cross-app sharing signal is wired on either OS. UNKNOWN is assumed not-sharing only while unavailable. */
export function readScreenShareSignal(): QuietPolicyInput['screenShare'] {
  return { available: false, state: 'unknown' }
}
