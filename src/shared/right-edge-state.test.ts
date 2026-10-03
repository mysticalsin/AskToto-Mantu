import { describe, expect, it } from 'vitest'
import { IPC } from './ipc'
import { RIGHT_EDGE_PINS, RightEdgeStateSchema, rightEdgeParkAllowed } from './right-edge-state'

describe('right-edge IPC contract (M2-0202 S2)', () => {
  it('names both channels and exactly nine pins', () => {
    expect(IPC.rightEdgeState).toBe('right-edge:state')
    expect(IPC.rightEdgeSurface).toBe('right-edge:surface')
    expect(RIGHT_EDGE_PINS).toEqual(['user', 'typing', 'ime', 'menu', 'drag', 'dialog', 'approval', 'execution', 'outcome'])
  })

  it('accepts a well-formed state report and refuses anything else', () => {
    expect(RightEdgeStateSchema.safeParse({ surface: 'island', contentHeight: 320, pins: ['typing', 'ime'] }).success).toBe(true)
    expect(RightEdgeStateSchema.safeParse({ surface: 'top-center', contentHeight: 0, pins: [] }).success).toBe(true)
    for (const bad of [
      { surface: 'dock', contentHeight: 0, pins: [] },
      { surface: 'island', contentHeight: -1, pins: [] },
      { surface: 'island', contentHeight: Number.NaN, pins: [] },
      { surface: 'island', contentHeight: 0, pins: ['notice'] },
      { surface: 'island', contentHeight: 0, pins: Array(10).fill('user') },
      { surface: 'island', contentHeight: 0 },
      null
    ]) {
      expect(RightEdgeStateSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('the park gate: any pin refuses the pointer leave-park and the auto-park; an explicit Hide yields only to an IME', () => {
    for (const cause of ['pointer-leave', 'auto-park', 'explicit'] as const) expect(rightEdgeParkAllowed([], cause)).toBe(true)
    for (const pin of RIGHT_EDGE_PINS) {
      expect(rightEdgeParkAllowed([pin], 'pointer-leave'), pin).toBe(false)
      expect(rightEdgeParkAllowed([pin], 'auto-park'), pin).toBe(false)
      expect(rightEdgeParkAllowed([pin], 'explicit'), pin).toBe(pin !== 'ime')
    }
  })
})
