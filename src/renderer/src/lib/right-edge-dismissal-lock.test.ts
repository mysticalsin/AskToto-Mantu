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
  it('pins every reducer transition explicitly', () => {
    const cases: Array<{
      state: RightEdgeDismissalLockState
      event: RightEdgeDismissalLockEvent
      expected: RightEdgeDismissalLockState
    }> = [
      { state: 'open', event: { type: 'explicit-close' }, expected: 'closing' },
      { state: 'closing', event: { type: 'explicit-close' }, expected: 'closing' },
      { state: 'awaiting-leave', event: { type: 'explicit-close' }, expected: 'closing' },
      { state: 'armed', event: { type: 'explicit-close' }, expected: 'closing' },
      { state: 'open', event: { type: 'explicit-reveal' }, expected: 'open' },
      { state: 'closing', event: { type: 'explicit-reveal' }, expected: 'open' },
      { state: 'awaiting-leave', event: { type: 'explicit-reveal' }, expected: 'open' },
      { state: 'armed', event: { type: 'explicit-reveal' }, expected: 'open' },
      { state: 'open', event: { type: 'metis-command' }, expected: 'open' },
      { state: 'closing', event: { type: 'metis-command' }, expected: 'open' },
      { state: 'awaiting-leave', event: { type: 'metis-command' }, expected: 'open' },
      { state: 'armed', event: { type: 'metis-command' }, expected: 'open' },
      { state: 'open', event: { type: 'native-hover-restored' }, expected: 'open' },
      { state: 'closing', event: { type: 'native-hover-restored' }, expected: 'open' },
      { state: 'awaiting-leave', event: { type: 'native-hover-restored' }, expected: 'open' },
      { state: 'armed', event: { type: 'native-hover-restored' }, expected: 'open' },
      { state: 'open', event: { type: 'park-settled', railHovering: false }, expected: 'open' },
      { state: 'closing', event: { type: 'park-settled', railHovering: false }, expected: 'armed' },
      { state: 'awaiting-leave', event: { type: 'park-settled', railHovering: false }, expected: 'awaiting-leave' },
      { state: 'armed', event: { type: 'park-settled', railHovering: false }, expected: 'armed' },
      { state: 'open', event: { type: 'renderer-pointer-enter' }, expected: 'open' },
      { state: 'closing', event: { type: 'renderer-pointer-enter' }, expected: 'closing' },
      { state: 'awaiting-leave', event: { type: 'renderer-pointer-enter' }, expected: 'awaiting-leave' },
      { state: 'armed', event: { type: 'renderer-pointer-enter' }, expected: 'open' },
      { state: 'open', event: { type: 'renderer-pointer-leave' }, expected: 'open' },
      { state: 'closing', event: { type: 'renderer-pointer-leave' }, expected: 'closing' },
      { state: 'awaiting-leave', event: { type: 'renderer-pointer-leave' }, expected: 'armed' },
      { state: 'armed', event: { type: 'renderer-pointer-leave' }, expected: 'armed' }
    ]

    expect(cases).toHaveLength(28)
    for (const entry of cases) {
      expect(reduceRightEdgeDismissalLock(entry.state, entry.event)).toBe(entry.expected)
    }
  })

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

  it('keeps ordinary park-settled cycles open so native hover remains active', () => {
    expect(reduceRightEdgeDismissalLock('open', { type: 'park-settled', railHovering: true })).toBe('open')
    const state = reduceRightEdgeDismissalLock('open', { type: 'park-settled', railHovering: false })

    expect(state).toBe('open')
    expect(shouldIgnoreRightEdgeNativeHover(state, false)).toBe(false)
  })

  it('does not consume park-settled after the explicit-close lock has already settled', () => {
    expect(reduceRightEdgeDismissalLock('armed', { type: 'park-settled', railHovering: false })).toBe('armed')
    expect(reduceRightEdgeDismissalLock('armed', { type: 'park-settled', railHovering: true })).toBe('armed')
    expect(reduceRightEdgeDismissalLock('awaiting-leave', { type: 'park-settled', railHovering: false })).toBe('awaiting-leave')
    expect(reduceRightEdgeDismissalLock('awaiting-leave', { type: 'park-settled', railHovering: true })).toBe('awaiting-leave')
  })

  it('keeps the ordinary auto-hide path revealable by native hover', () => {
    const parked = reduceRightEdgeDismissalLock('open', { type: 'park-settled', railHovering: false })

    expect(shouldIgnoreRightEdgeNativeHover(parked, false)).toBe(false)
    expect(reduceNativeHover(parked, false)).toEqual({ state: 'open', reopened: false })
  })
})
