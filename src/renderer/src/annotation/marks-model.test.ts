import { describe, expect, it } from 'vitest'
import type { MarkView } from '@shared/screen-marks'
import { arrowGeometry, MARK_EXIT_MS, nextDrawnMarks } from './marks-model'

const point = (id: string): MarkView => ({ markId: id, kind: 'point', x: 10, y: 20 })

describe('nextDrawnMarks (G45)', () => {
  it('keeps a mark main dropped only for its exit, then removes it', () => {
    const shown = nextDrawnMarks([], [point('a'), point('b')], 0)
    const leaving = nextDrawnMarks(shown, [point('b')], 50)
    expect(leaving.map((m) => [m.view.markId, m.leaving])).toEqual([
      ['b', false],
      ['a', true]
    ])
    expect(nextDrawnMarks(leaving, [point('b')], 50 + MARK_EXIT_MS - 1)).toHaveLength(2)
    expect(nextDrawnMarks(leaving, [point('b')], 50 + MARK_EXIT_MS)).toHaveLength(1)
  })

  it('a mark main lists again is live, not leaving', () => {
    const leaving = nextDrawnMarks(nextDrawnMarks([], [point('a')], 0), [], 10)
    expect(nextDrawnMarks(leaving, [point('a')], 20)).toEqual([{ view: point('a'), leaving: false }])
  })
})

describe('arrowGeometry', () => {
  it('starts at the tail, spans the distance and points at the head', () => {
    expect(arrowGeometry({ x: 0, y: 0 }, { x: 30, y: 40 })).toMatchObject({ left: 0, top: 0, length: 50 })
    expect(arrowGeometry({ x: 0, y: 0 }, { x: 0, y: 10 }).angle).toBe(90)
    expect(arrowGeometry({ x: 10, y: 0 }, { x: 0, y: 0 }).angle).toBe(180)
  })
})
