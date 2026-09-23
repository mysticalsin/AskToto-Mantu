import { describe, expect, it } from 'vitest'
import {
  reduceRightEdgeDismissalLock,
  shouldIgnoreRightEdgeNativeHover
} from './right-edge-dismissal-lock'

describe('right-edge dismissal lock', () => {
  it('keeps the close lock through the shrink-time pointer leave so stale native hover cannot reopen', () => {
    let locked = reduceRightEdgeDismissalLock(false, 'explicit-close')

    locked = reduceRightEdgeDismissalLock(locked, 'renderer-pointer-leave')

    expect(locked).toBe(true)
    expect(shouldIgnoreRightEdgeNativeHover(locked, false)).toBe(true)
  })

  it('lets the first genuine rail pointer-enter after a keyboard close consume the lock', () => {
    let locked = reduceRightEdgeDismissalLock(false, 'explicit-close')

    locked = reduceRightEdgeDismissalLock(locked, 'renderer-pointer-enter')

    expect(locked).toBe(false)
    expect(shouldIgnoreRightEdgeNativeHover(locked, false)).toBe(false)
  })
})
