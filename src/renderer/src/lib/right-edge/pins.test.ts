import { describe, expect, it } from 'vitest'
import { RE_TYPING_PIN_MS } from '@shared/right-edge-timing'
import { RIGHT_EDGE_PINS, createAttentionLatch, rightEdgePins, typingPinRemainingMs } from './pins'

describe('right-edge pins (M2-0202 S2, RE-P01 island rows)', () => {
  it('defines the nine pins, each from its own page state', () => {
    expect(RIGHT_EDGE_PINS).toHaveLength(9)
    expect(rightEdgePins({}, 0)).toEqual([])
    expect(
      rightEdgePins(
        {
          userPinned: true,
          lastKeystrokeAt: 0,
          composing: true,
          menuOpen: true,
          dragging: true,
          dialogOpen: true,
          approvalPending: true,
          executing: true,
          outcomeUnknown: true
        },
        0
      )
    ).toEqual([...RIGHT_EDGE_PINS])
    expect(rightEdgePins({ menuOpen: true, approvalPending: true }, 0)).toEqual(['menu', 'approval'])
  })

  it('click into an empty composer, pointer leaves: the typing pin holds 8 s, then lapses', () => {
    // A pointerdown in the composer is a keystroke (the re-review D2 amendment): it starts the same hold.
    const clickedAt = 1_000
    expect(RE_TYPING_PIN_MS).toBe(8_000)
    expect(rightEdgePins({ lastKeystrokeAt: clickedAt }, clickedAt)).toEqual(['typing'])
    expect(rightEdgePins({ lastKeystrokeAt: clickedAt }, clickedAt + 7_999)).toEqual(['typing'])
    expect(typingPinRemainingMs(clickedAt, clickedAt + 7_999)).toBe(1)
    expect(rightEdgePins({ lastKeystrokeAt: clickedAt }, clickedAt + 8_000)).toEqual([])
    expect(typingPinRemainingMs(clickedAt, clickedAt + 9_000)).toBe(0)
    expect(typingPinRemainingMs(null, clickedAt)).toBe(0)
  })

  it('an attention item reveals once per item; a repeat of the same item never reveals again', () => {
    const due = createAttentionLatch()
    expect(due(null)).toBe(false)
    expect(due('proposal-1')).toBe(true)
    expect(due('proposal-1')).toBe(false)
    expect(due('proposal-2')).toBe(true)
    expect(due(null)).toBe(false)
    expect(due('proposal-1')).toBe(false)
  })
})
