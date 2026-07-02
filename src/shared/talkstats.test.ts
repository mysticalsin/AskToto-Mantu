import { describe, it, expect } from 'vitest'
import type { TranscriptLine } from './ipc'
import { talkStats } from './talkstats'

const T0 = 1_700_000_000_000
const line = (speaker: 'you' | 'them', text: string, secondsIn: number): TranscriptLine => ({
  speaker,
  text,
  t: T0 + secondsIn * 1000
})

describe('talkStats', () => {
  it('computes word share from real word counts', () => {
    const s = talkStats([
      line('you', 'one two three four five six', 0), // 6 words
      line('them', 'seven eight nine ten', 10) // 4 words
    ])
    expect(s.youWords).toBe(6)
    expect(s.themWords).toBe(4)
    expect(s.youShare).toBeCloseTo(0.6)
  })

  it('measures the longest unbroken you-monologue by timestamps', () => {
    const s = talkStats([
      line('them', 'question?', 0),
      line('you', 'part one', 5),
      line('you', 'part two', 65),
      line('you', 'part three', 95),
      line('them', 'ok', 125), // run spanned 5s → 125s = 120s
      line('you', 'short', 130),
      line('them', 'bye', 135) // 5s run
    ])
    expect(s.longestMonologueSec).toBe(120)
  })

  it('counts their questions, not yours', () => {
    const s = talkStats([
      line('them', 'what is the price?', 0),
      line('you', 'why do you ask?', 5), // yours — not counted
      line('them', 'is that final? and firm?', 10), // one line with ? → one question line
      line('them', 'fine.', 15)
    ])
    expect(s.themQuestions).toBe(2)
  })

  it('empty or silent transcripts return null share, zero everything', () => {
    expect(talkStats([])).toEqual({ youShare: null, youWords: 0, themWords: 0, longestMonologueSec: 0, themQuestions: 0 })
    expect(talkStats([line('you', '   ', 0)]).youShare).toBeNull()
  })
})
