import { describe, expect, it } from 'vitest'
import { cursorPositionAt, easeOutCubic } from './synthetic-cursor'

describe('MQA-277 — synthetic cursor easing (easeOutCubic)', () => {
  it('starts at 0 and ends at 1, clamped for any out-of-range input', () => {
    expect(easeOutCubic(0)).toBe(0)
    expect(easeOutCubic(1)).toBe(1)
    expect(easeOutCubic(-5)).toBe(0)
    expect(easeOutCubic(5)).toBe(1)
  })

  it('is monotonically increasing (a "hand reaching" curve never moves backwards)', () => {
    let prev = -1
    for (let p = 0; p <= 1; p += 0.05) {
      const v = easeOutCubic(p)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })

  it('front-loads motion (ease-OUT): halfway through elapsed progress it has covered more than half the distance', () => {
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5)
  })
})

describe('MQA-277 — synthetic cursor path (cursorPositionAt)', () => {
  const from = { x: 0, y: 0 }
  const to = { x: 100, y: 40 }

  it('is exactly the start point at progress 0 and exactly the end point at progress 1', () => {
    expect(cursorPositionAt(0, from, to)).toEqual({ x: 0, y: 0 })
    expect(cursorPositionAt(1, from, to)).toEqual(to)
  })

  it('lifts along an upward arc mid-path (y is above the straight-line interpolation, i.e. a smaller y)', () => {
    const straightLineY = (from.y + to.y) / 2
    const mid = cursorPositionAt(0.5, from, to)
    expect(mid.y).toBeLessThan(straightLineY)
  })

  it('the arc vanishes at both endpoints regardless of arcPx', () => {
    const start = cursorPositionAt(0, from, to, 50)
    const end = cursorPositionAt(1, from, to, 50)
    expect(start.y).toBe(from.y)
    expect(end.y).toBe(to.y)
  })

  it('clamps out-of-range progress to the nearest endpoint', () => {
    expect(cursorPositionAt(-2, from, to)).toEqual({ x: 0, y: 0 })
    expect(cursorPositionAt(2, from, to)).toEqual(to)
  })
})
