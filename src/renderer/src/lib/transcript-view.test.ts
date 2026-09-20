import { describe, expect, it } from 'vitest'
import {
  STICK_SLACK_PX,
  groupTranscriptRows,
  isFollowingTail,
  newLinesLabel,
  transcriptElapsed,
  transcriptMaxHeight
} from './transcript-view'
import type { TranscriptLine } from '@shared/ipc'

function line(over: Partial<TranscriptLine> = {}): TranscriptLine {
  return { speaker: 'them', text: 'hello', t: 0, ...over } as TranscriptLine
}

describe('transcript height comes from the display, never the viewport', () => {
  it('claims real room on a real display instead of a 240px slot', () => {
    // The old cap was 240px, roughly four lines of speech, on the surface you read during a call.
    expect(transcriptMaxHeight(1169)).toBeGreaterThan(240)
    expect(transcriptMaxHeight(1169)).toBeGreaterThan(500)
  })

  it('keeps a readable floor on a short display and never returns NaN', () => {
    expect(transcriptMaxHeight(400)).toBe(360)
    expect(transcriptMaxHeight(undefined)).toBe(360)
    expect(transcriptMaxHeight(Number.NaN)).toBe(360)
    expect(transcriptMaxHeight(0)).toBe(360)
  })

  it('grows with the display', () => {
    expect(transcriptMaxHeight(2112)).toBeGreaterThan(transcriptMaxHeight(1169))
  })
})

describe('an arriving line must not steal the reader position', () => {
  it('follows the tail only when the reader is already at the bottom', () => {
    expect(isFollowingTail({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 })).toBe(true)
    // A line of slack still counts as following along.
    expect(
      isFollowingTail({ scrollTop: 900 - STICK_SLACK_PX, scrollHeight: 1000, clientHeight: 100 })
    ).toBe(true)
  })

  it('does not follow when the reader has scrolled up to re-read something', () => {
    expect(isFollowingTail({ scrollTop: 200, scrollHeight: 1000, clientHeight: 100 })).toBe(false)
  })

  it('a fresh, unscrollable transcript counts as following', () => {
    expect(isFollowingTail({ scrollTop: 0, scrollHeight: 100, clientHeight: 100 })).toBe(true)
  })
})

describe('grouping reads conversation as turns, not as a stack of strangers', () => {
  it('labels the first line of a run and suppresses the repeats', () => {
    const rows = groupTranscriptRows([
      line({ speaker: 'them', name: 'Ada', text: 'one' }),
      line({ speaker: 'them', name: 'Ada', text: 'two' }),
      line({ speaker: 'you', text: 'three' })
    ])
    expect(rows.map((r) => r.startsGroup)).toEqual([true, false, true])
    expect(rows.map((r) => r.endsGroup)).toEqual([false, true, true])
  })

  it('two different named people are two groups even though both are "them"', () => {
    // The point of resolving speaker names: a meeting with three colleagues must not read as one
    // undifferentiated other party.
    const rows = groupTranscriptRows([
      line({ speaker: 'them', name: 'Ada' }),
      line({ speaker: 'them', name: 'Grace' })
    ])
    expect(rows.map((r) => r.startsGroup)).toEqual([true, true])
  })

  it('keeps the original index so keys stay stable as the render window slides', () => {
    const rows = groupTranscriptRows([line(), line(), line()])
    expect(rows.map((r) => r.index)).toEqual([0, 1, 2])
  })

  it('an empty transcript groups into nothing rather than throwing', () => {
    expect(groupTranscriptRows([])).toEqual([])
  })
})

describe('elapsed time says how far into the call a line was', () => {
  it('counts from the first line, not the wall clock', () => {
    expect(transcriptElapsed(65_000, 0)).toBe('1:05')
    expect(transcriptElapsed(0, 0)).toBe('0:00')
    expect(transcriptElapsed(3_600_000, 0)).toBe('60:00')
  })

  it('omits itself rather than printing a negative or NaN time', () => {
    expect(transcriptElapsed(10, 1000)).toBeNull()
    expect(transcriptElapsed(undefined, 0)).toBeNull()
    expect(transcriptElapsed(1000, undefined)).toBeNull()
    expect(transcriptElapsed(Number.NaN, 0)).toBeNull()
  })
})

describe('the jump-to-latest pill counts honestly', () => {
  it('is singular for one line', () => {
    expect(newLinesLabel(1)).toBe('1 new line')
    expect(newLinesLabel(2)).toBe('2 new lines')
    expect(newLinesLabel(0)).toBe('0 new lines')
  })
})
