import { describe, expect, it } from 'vitest'
import {
  EMAIL_SUMMARY_MIN,
  MCP_PUSH_MIN,
  NOTE_TAKING_WPM,
  estimateEmailSummaryMinutes,
  estimateMcpPushMinutes,
  estimateNoteTakingMinutes,
  estimateSecondBrainMinutes,
  kindLabel,
  totalsFromEvents,
  wordsFromTexts,
  type TimeSavedEvent
} from './time-saved-events'

describe('note-taking heuristic = words / 180 wpm', () => {
  it('credits 1 min for a short note and scales with words', () => {
    expect(estimateNoteTakingMinutes(0)).toBe(0)
    expect(estimateNoteTakingMinutes(20)).toBe(1)
    expect(estimateNoteTakingMinutes(NOTE_TAKING_WPM)).toBe(1)
    expect(estimateNoteTakingMinutes(NOTE_TAKING_WPM * 2)).toBe(2)
    expect(estimateNoteTakingMinutes(900)).toBe(5)
  })

  it('rejects non-finite input instead of inventing minutes', () => {
    expect(estimateNoteTakingMinutes(Number.NaN)).toBe(0)
    expect(estimateNoteTakingMinutes(-12)).toBe(0)
  })
})

describe('second-brain = 2 min per opportunity, cap 15', () => {
  it('credits only captured opportunities', () => {
    expect(estimateSecondBrainMinutes(0)).toBe(0)
    expect(estimateSecondBrainMinutes(1)).toBe(2)
    expect(estimateSecondBrainMinutes(3)).toBe(6)
    expect(estimateSecondBrainMinutes(20)).toBe(15)
  })
})

describe('fixed heuristics', () => {
  it('email summary is 4 min and MCP push is 3 min', () => {
    expect(estimateEmailSummaryMinutes()).toBe(EMAIL_SUMMARY_MIN)
    expect(estimateEmailSummaryMinutes()).toBe(4)
    expect(estimateMcpPushMinutes()).toBe(MCP_PUSH_MIN)
    expect(estimateMcpPushMinutes()).toBe(3)
  })
})

describe('totalsFromEvents', () => {
  it('sums estimates by kind and never invents a row', () => {
    const events: TimeSavedEvent[] = [
      { kind: 'note-taking', timestamp: 1, estimatedMinutes: 5 },
      { kind: 'email-summary', timestamp: 2, estimatedMinutes: 4 },
      { kind: 'mcp-push', timestamp: 3, estimatedMinutes: 3, connector: 'outlook' }
    ]
    const t = totalsFromEvents(events)
    expect(t.savedMinutes).toBe(12)
    expect(t.byKind['note-taking']).toBe(5)
    expect(t.byKind['second-brain']).toBe(0)
    expect(t.events).toBe(3)
  })
})

describe('wordsFromTexts', () => {
  it('joins parts the way a saved note is counted', () => {
    expect(wordsFromTexts('hello world', 'more')).toBe(3)
    expect(wordsFromTexts(undefined, '')).toBe(0)
  })
})

describe('kindLabel', () => {
  it('uses original Métis copy with no em dash', () => {
    expect(kindLabel('email-summary')).toBe('Email + next steps')
    expect(kindLabel('second-brain')).toBe('Second brain')
    expect(Object.values(['note-taking', 'second-brain', 'email-summary', 'mcp-push'] as const).map(kindLabel).join(' ')).not.toMatch(
      /—/
    )
  })
})
