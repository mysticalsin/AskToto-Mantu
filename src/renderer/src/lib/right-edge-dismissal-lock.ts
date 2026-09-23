export type RightEdgeDismissalLockState = 'open' | 'closing' | 'awaiting-leave' | 'armed'

export type RightEdgeDismissalLockEvent =
  | { type: 'explicit-close' }
  | { type: 'explicit-reveal' }
  | { type: 'metis-command' }
  | { type: 'native-hover-restored' }
  | { type: 'park-settled'; railHovering: boolean }
  | { type: 'renderer-pointer-enter' }
  | { type: 'renderer-pointer-leave' }

export function reduceRightEdgeDismissalLock(
  state: RightEdgeDismissalLockState,
  event: RightEdgeDismissalLockEvent
): RightEdgeDismissalLockState {
  switch (event.type) {
    case 'explicit-close':
      return 'closing'
    case 'park-settled':
      return event.railHovering ? 'awaiting-leave' : 'armed'
    case 'renderer-pointer-enter':
      return state === 'armed' ? 'open' : state
    case 'renderer-pointer-leave':
      return state === 'awaiting-leave' ? 'armed' : state
    case 'explicit-reveal':
    case 'metis-command':
    case 'native-hover-restored':
      return 'open'
  }
}

export function shouldIgnoreRightEdgeNativeHover(
  state: RightEdgeDismissalLockState,
  restoredFromParkedRail?: boolean
): boolean {
  return state !== 'open' && !restoredFromParkedRail
}
