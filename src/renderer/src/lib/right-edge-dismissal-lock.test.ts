import { describe, expect, it } from 'vitest'
import {
  reduceRightEdgeDismissalLock,
  shouldIgnoreRightEdgeNativeHover,
  type RightEdgeDismissalLockEvent,
  type RightEdgeDismissalLockState
} from './right-edge-dismissal-lock'

function reduceDockEvent(
  state: RightEdgeDismissalLockState,
  event: RightEdgeDismissalLockEvent
): { reopened: boolean; state: RightEdgeDismissalLockState } {
  const next = reduceRightEdgeDismissalLock(state, event)
  return {
    reopened: state !== 'open' && next === 'open',
    state: next
  }
}

function reduceNativeHover(
  state: RightEdgeDismissalLockState,
  restoredFromParkedRail: boolean
): { reopened: boolean; state: RightEdgeDismissalLockState } {
  if (shouldIgnoreRightEdgeNativeHover(state, restoredFromParkedRail)) {
    return { reopened: false, state }
  }
  return reduceDockEvent(state, { type: 'native-hover-restored' })
}

describe('right-edge dismissal lock', () => {
  it('ignores the park-time enter until the pointer leaves and genuinely returns', () => {
    let state = reduceRightEdgeDismissalLock('open', { type: 'explicit-close' })

    let result = reduceDockEvent(state, { type: 'renderer-pointer-enter' })
    expect(result).toEqual({ state: 'closing', reopened: false })

    result = reduceDockEvent(result.state, { type: 'park-settled', railHovering: true })
    expect(result).toEqual({ state: 'awaiting-leave', reopened: false })

    result = reduceDockEvent(result.state, { type: 'renderer-pointer-leave' })
    expect(result).toEqual({ state: 'armed', reopened: false })

    result = reduceDockEvent(result.state, { type: 'renderer-pointer-enter' })
    expect(result).toEqual({ state: 'open', reopened: true })
  })

  it('keeps the close lock through the shrink-time pointer leave so stale native hover cannot reopen', () => {
    let state = reduceRightEdgeDismissalLock('open', { type: 'explicit-close' })

    state = reduceRightEdgeDismissalLock(state, { type: 'renderer-pointer-leave' })
    const result = reduceNativeHover(state, false)

    expect(result).toEqual({ state: 'closing', reopened: false })
    expect(shouldIgnoreRightEdgeNativeHover(result.state, false)).toBe(true)
  })

  it('lets the first genuine rail pointer-enter after a keyboard close consume the lock', () => {
    let state = reduceRightEdgeDismissalLock('open', { type: 'explicit-close' })

    state = reduceRightEdgeDismissalLock(state, { type: 'park-settled', railHovering: false })
    const result = reduceDockEvent(state, { type: 'renderer-pointer-enter' })

    expect(result).toEqual({ state: 'open', reopened: true })
    expect(shouldIgnoreRightEdgeNativeHover(result.state, false)).toBe(false)
  })

  it('lets native restoredFromParkedRail reopen even while closing', () => {
    const state = reduceRightEdgeDismissalLock('open', { type: 'explicit-close' })

    const result = reduceNativeHover(state, true)

    expect(result).toEqual({ state: 'open', reopened: true })
  })

  it('lets the metis-command hotkey reopen while awaiting a leave', () => {
    const state = reduceRightEdgeDismissalLock('closing', { type: 'park-settled', railHovering: true })

    const result = reduceDockEvent(state, { type: 'metis-command' })

    expect(result).toEqual({ state: 'open', reopened: true })
  })
})
