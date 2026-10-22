import { describe, expect, it } from 'vitest'
import type { TranscriptLine } from '@shared/ipc'
import { drainedLines, retiringMeeting } from './retiring-meeting'

const line = (text: string, t: number, extra: Partial<TranscriptLine> = {}): TranscriptLine => ({
  speaker: 'them',
  text,
  t,
  ...extra
})

describe('drainedLines', () => {
  it('prefers the live read that includes the drained tail', () => {
    const floor = [line('a', 1)]
    const live = [line('a', 1), line('tail', 2)]
    expect(drainedLines(floor, live)).toEqual(live)
  })

  it('falls back to the click-time lines when the live read was cleared', () => {
    const floor = [line('a', 1), line('b', 2)]
    expect(drainedLines(floor, [])).toEqual(floor)
  })

  it('ignores placeholder lines on both sides', () => {
    const floor = [line('a', 1), line('…', 2, { provisional: true })]
    const live = [line('a', 1)]
    expect(drainedLines(floor, live)).toEqual([line('a', 1)])
  })
})

describe('retiringMeeting', () => {
  it('reads the live lines at save time, not at construction', () => {
    const live = [line('a', 1)]
    const retiring = retiringMeeting(100, null, [...live], () => live)
    live.push(line('tail', 2))
    expect(retiring.readLines()).toHaveLength(2)
    expect(retiring.started).toBe(100)
  })
})
