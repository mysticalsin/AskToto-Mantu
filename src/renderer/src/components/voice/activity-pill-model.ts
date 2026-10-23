/**
 * activity-pill-model.ts — the top-edge activity pill (G30): dictation, a continuous conversation and a spoken reply.
 *
 * Pure: main's snapshots in, one view out. It sits in the same place and shape as the V05 voice pill and only shows
 * when no voice-action turn is on screen (that turn always wins). Priority is dictation, then conversation, then a
 * spoken reply: what the person is doing right now beats what Métis is doing. Copy is sentence case and never
 * carries speech, a transcript or a reply; the only dynamic text is a countdown and main's own fixed-copy messages.
 * Inputs are structural so the G28 conversation snapshot and the G27 spoken-replies state fit without adapters.
 */

export interface DictationStatusInput {
  readonly state: 'off' | 'idle' | 'starting' | 'listening' | 'thinking' | 'inserting' | 'done' | 'failed'
  /** Main's fixed copy for a refusal or failure, when it has one. */
  readonly message?: string | null
  readonly enabled: boolean
}

export interface ConversationStatusInput {
  readonly state: 'off' | 'idle' | 'listening' | 'thinking' | 'replying' | 'ended'
  readonly active: boolean
  readonly stopAvailable: boolean
  readonly idleExpiresAt: number | null
  readonly maxExpiresAt: number | null
  readonly message: string | null
  readonly enabled: boolean
}

export interface SpokenReplyStatusInput {
  readonly playback: 'idle' | 'reply' | 'preview'
}

export type ActivityGlyph = 'listening' | 'working' | 'speaking' | 'done' | 'info'
export type ActivitySource = 'dictation' | 'conversation' | 'spoken-reply'
export type ActivityAction = 'stop-conversation' | 'stop-reply'

export interface ActivityPillView {
  source: ActivitySource
  /** Identity for transitions: source plus its state. */
  key: string
  glyph: ActivityGlyph
  title: string
  detail: string | null
  /** The one control that works now, if any. A status never offers a button that cannot act. */
  action: { kind: ActivityAction; label: string } | null
  /** A terminal state holds this long, then leaves; null waits for main. */
  holdMs: number | null
}

/** Matches the V05 terminal holds so the two pills behave alike. */
export const ACTIVITY_DONE_HOLD_MS = 1_200
export const ACTIVITY_FAILED_HOLD_MS = 4_000
/** Under this, the conversation countdown says so: the person should know it is about to end. */
export const CONVERSATION_ENDING_SOON_MS = 60_000

export interface ActivityInputs {
  dictation?: DictationStatusInput | null
  conversation?: ConversationStatusInput | null
  spokenReply?: SpokenReplyStatusInput | null
  now: number
}

export function activityPillView(inputs: ActivityInputs): ActivityPillView | null {
  return dictationView(inputs.dictation) ?? conversationView(inputs.conversation, inputs.now) ?? replyView(inputs)
}

function dictationView(d: DictationStatusInput | null | undefined): ActivityPillView | null {
  if (!d?.enabled) return null
  const base = { source: 'dictation' as const, key: `dictation:${d.state}`, action: null }
  switch (d.state) {
    case 'starting':
    case 'listening':
      return { ...base, glyph: 'listening', title: 'Dictating…', detail: "Let go when you're done", holdMs: null }
    case 'thinking':
      return { ...base, glyph: 'working', title: 'Writing it out…', detail: null, holdMs: null }
    case 'inserting':
      return { ...base, glyph: 'working', title: 'Typing it in…', detail: null, holdMs: null }
    case 'done':
      return { ...base, glyph: 'done', title: 'Inserted', detail: null, holdMs: ACTIVITY_DONE_HOLD_MS }
    case 'failed':
      return {
        ...base,
        glyph: 'info',
        title: d.message?.trim() || "Couldn't insert the text.",
        detail: 'Your words are kept as a draft.',
        holdMs: ACTIVITY_FAILED_HOLD_MS
      }
    default:
      return null
  }
}

function conversationView(c: ConversationStatusInput | null | undefined, now: number): ActivityPillView | null {
  if (!c?.enabled) return null
  if (!c.active) {
    // An ended session says why once (main's fixed copy), then leaves.
    if (c.state === 'ended' && c.message) {
      return {
        source: 'conversation',
        key: 'conversation:ended',
        glyph: 'info',
        title: c.message,
        detail: null,
        action: null,
        holdMs: ACTIVITY_FAILED_HOLD_MS
      }
    }
    return null
  }
  const title =
    c.state === 'thinking' ? 'Thinking…' : c.state === 'replying' ? 'Answering…' : 'Conversation on · listening'
  const glyph: ActivityGlyph = c.state === 'listening' ? 'listening' : c.state === 'replying' ? 'speaking' : 'working'
  return {
    source: 'conversation',
    key: `conversation:${c.state}`,
    glyph,
    title,
    detail: conversationCountdown(c, now),
    action: c.stopAvailable ? { kind: 'stop-conversation', label: 'Stop' } : null,
    holdMs: null
  }
}

/** The nearer of the two deadlines, in whole minutes, or "less than a minute" when it is close. */
export function conversationCountdown(c: ConversationStatusInput, now: number): string | null {
  const deadlines = [c.idleExpiresAt, c.maxExpiresAt].filter((d): d is number => typeof d === 'number')
  if (deadlines.length === 0) return null
  const remaining = Math.min(...deadlines) - now
  if (remaining <= 0) return 'Ending…'
  if (remaining < CONVERSATION_ENDING_SOON_MS) return 'Ends in less than a minute'
  const minutes = Math.ceil(remaining / 60_000)
  return `Ends in ${minutes} min`
}

function replyView(inputs: ActivityInputs): ActivityPillView | null {
  // A reply inside a live conversation is already shown as "Answering…" by the conversation row.
  if (inputs.conversation?.active) return null
  if (inputs.spokenReply?.playback !== 'reply') return null
  return {
    source: 'spoken-reply',
    key: 'spoken-reply:reply',
    glyph: 'speaking',
    title: 'Reading the answer aloud',
    detail: null,
    action: { kind: 'stop-reply', label: 'Stop' },
    holdMs: null
  }
}
