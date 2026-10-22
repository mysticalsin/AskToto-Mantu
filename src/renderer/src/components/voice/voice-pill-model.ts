/**
 * voice-pill-model.ts — what the voice actions pill shows for each main-owned turn state (V05, design §1.4).
 *
 * Pure: main's snapshot in, a view out. Copy is sentence case and never interpolates speech the renderer heard;
 * the only dynamic text is main's own fixed-copy `message` (reason copy or an allowlisted action result).
 */
import type { VoiceState, VoiceStateSnapshot } from '@shared/voice/voice-turn'

export type VoicePillGlyph = 'listening' | 'working' | 'done' | 'info'

export interface VoicePillView {
  state: VoiceState
  glyph: VoicePillGlyph
  title: string
  detail: string | null
  /** Milliseconds the pill holds a terminal state before it leaves on its own; null waits for main. */
  holdMs: number | null
}

/** How many reveals keep the "Let go when you're done" hint (design §1.4: first 3 uses only). */
export const VOICE_HINT_USES = 3
/** A finished turn holds this long, then leaves (design §1.6). */
export const VOICE_DONE_HOLD_MS = 1_200
/** An uncertain outcome stays until dismissed or this long (design §1.6), so it is never missed. */
export const VOICE_UNCERTAIN_HOLD_MS = 8_000
/** A failure is read, then leaves; main also clears it on its own timer. */
export const VOICE_FAILED_HOLD_MS = 4_000

const VISIBLE: ReadonlySet<VoiceState> = new Set([
  'listening',
  'thinking',
  'proposing',
  'confirming',
  'executing',
  'done',
  'failed',
  'uncertain'
])

export function voicePillVisible(snapshot: VoiceStateSnapshot | null): boolean {
  return !!snapshot && snapshot.enabled && VISIBLE.has(snapshot.state)
}

/** The pill view for a visible state, or null when nothing should show. */
export function voicePillView(snapshot: VoiceStateSnapshot | null, hintsShown: number): VoicePillView | null {
  if (!snapshot || !voicePillVisible(snapshot)) return null
  const message = snapshot.message?.trim() || null
  switch (snapshot.state) {
    case 'listening':
      return {
        state: 'listening',
        glyph: 'listening',
        title: 'Listening…',
        detail: hintsShown < VOICE_HINT_USES ? "Let go when you're done" : null,
        holdMs: null
      }
    case 'thinking':
      return { state: 'thinking', glyph: 'working', title: 'Working on it…', detail: null, holdMs: null }
    case 'proposing':
    case 'confirming':
      return {
        state: snapshot.state,
        glyph: 'working',
        title: message ?? 'Check the request below',
        detail: null,
        holdMs: null
      }
    case 'executing':
      return { state: 'executing', glyph: 'working', title: message ?? 'Working on it…', detail: null, holdMs: null }
    case 'done':
      return { state: 'done', glyph: 'done', title: message ?? 'Done', detail: null, holdMs: VOICE_DONE_HOLD_MS }
    case 'uncertain':
      return {
        state: 'uncertain',
        glyph: 'info',
        title: message ?? "Métis couldn't confirm it worked.",
        detail: 'Check before trying again.',
        holdMs: VOICE_UNCERTAIN_HOLD_MS
      }
    default:
      return {
        state: 'failed',
        glyph: 'info',
        title: message ?? 'Stopped. Nothing was done.',
        detail: null,
        holdMs: VOICE_FAILED_HOLD_MS
      }
  }
}

export type VoiceCue = 'listen' | 'send' | 'ready' | 'error'

/** The one sound for a state change, if any (design §1.7): listen at the hold, send on release, ready, error. */
export function voiceCueFor(previous: VoiceState | null, next: VoiceState): VoiceCue | null {
  if (previous === next) return null
  if (next === 'listening') return 'listen'
  if (previous === 'listening' && next === 'thinking') return 'send'
  if (next === 'done') return 'ready'
  if (next === 'failed') return 'error'
  return null
}
