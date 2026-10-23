import { describe, expect, it } from 'vitest'
import {
  activityPillView,
  conversationCountdown,
  type ConversationStatusInput,
  type DictationStatusInput
} from './activity-pill-model'

const NOW = 1_000_000
const conv = (over: Partial<ConversationStatusInput> = {}): ConversationStatusInput => ({
  state: 'listening',
  active: true,
  stopAvailable: true,
  idleExpiresAt: NOW + 5 * 60_000,
  maxExpiresAt: NOW + 30 * 60_000,
  message: null,
  enabled: true,
  ...over
})
const dict = (
  state: DictationStatusInput['state'],
  over: Partial<DictationStatusInput> = {}
): DictationStatusInput => ({
  state,
  enabled: true,
  ...over
})

describe('activityPillView (G30)', () => {
  it('shows nothing when every feature is idle or off', () => {
    expect(activityPillView({ now: NOW })).toBeNull()
    expect(activityPillView({ dictation: dict('idle'), spokenReply: { playback: 'idle' }, now: NOW })).toBeNull()
    expect(activityPillView({ dictation: dict('listening', { enabled: false }), now: NOW })).toBeNull()
  })

  it('dictation wins over a conversation and a reply: what the person is doing comes first', () => {
    const view = activityPillView({
      dictation: dict('listening'),
      conversation: conv(),
      spokenReply: { playback: 'reply' },
      now: NOW
    })
    expect(view).toMatchObject({ source: 'dictation', glyph: 'listening', title: 'Dictating…', action: null })
  })

  it('a dictation failure keeps the draft promise and holds long enough to read', () => {
    const view = activityPillView({ dictation: dict('failed'), now: NOW })
    expect(view).toMatchObject({
      title: "Couldn't insert the text.",
      detail: 'Your words are kept as a draft.',
      holdMs: 4_000
    })
    expect(
      activityPillView({ dictation: dict('failed', { message: 'This field is a password.' }), now: NOW })?.title
    ).toBe('This field is a password.')
  })

  it('a live conversation always shows, with its countdown and a Stop that works', () => {
    const view = activityPillView({ conversation: conv(), now: NOW })
    expect(view).toMatchObject({
      source: 'conversation',
      title: 'Conversation on · listening',
      detail: 'Ends in 5 min',
      action: { kind: 'stop-conversation', label: 'Stop' }
    })
    expect(activityPillView({ conversation: conv({ stopAvailable: false }), now: NOW })?.action).toBeNull()
  })

  it('a reply inside a conversation is the conversation row, not a second pill', () => {
    const view = activityPillView({
      conversation: conv({ state: 'replying' }),
      spokenReply: { playback: 'reply' },
      now: NOW
    })
    expect(view).toMatchObject({ source: 'conversation', title: 'Answering…', glyph: 'speaking' })
  })

  it('a spoken reply on its own offers Stop; a settings preview shows nothing here', () => {
    expect(activityPillView({ spokenReply: { playback: 'reply' }, now: NOW })).toMatchObject({
      source: 'spoken-reply',
      action: { kind: 'stop-reply', label: 'Stop' }
    })
    expect(activityPillView({ spokenReply: { playback: 'preview' }, now: NOW })).toBeNull()
  })

  it('an ended conversation says why once, from main copy only', () => {
    const view = activityPillView({
      conversation: conv({ state: 'ended', active: false, message: 'Conversation ended after 5 minutes of silence.' }),
      now: NOW
    })
    expect(view).toMatchObject({ title: 'Conversation ended after 5 minutes of silence.', action: null })
  })
})

describe('conversationCountdown', () => {
  it('counts the nearer deadline in whole minutes and warns under a minute', () => {
    expect(conversationCountdown(conv({ idleExpiresAt: NOW + 90_000 }), NOW)).toBe('Ends in 2 min')
    expect(conversationCountdown(conv({ idleExpiresAt: NOW + 30_000 }), NOW)).toBe('Ends in less than a minute')
    expect(conversationCountdown(conv({ idleExpiresAt: NOW - 1 }), NOW)).toBe('Ending…')
    expect(conversationCountdown(conv({ idleExpiresAt: null, maxExpiresAt: null }), NOW)).toBeNull()
  })
})
