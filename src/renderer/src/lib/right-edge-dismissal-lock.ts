export type RightEdgeDismissalLockEvent =
  | 'explicit-close'
  | 'explicit-reveal'
  | 'native-hover-restored'
  | 'renderer-pointer-enter'
  | 'renderer-pointer-leave'

export function reduceRightEdgeDismissalLock(locked: boolean, event: RightEdgeDismissalLockEvent): boolean {
  switch (event) {
    case 'explicit-close':
      return true
    case 'renderer-pointer-leave':
      return locked
    case 'explicit-reveal':
    case 'native-hover-restored':
    case 'renderer-pointer-enter':
      return false
  }
}

export function shouldIgnoreRightEdgeNativeHover(locked: boolean, restoredFromParkedRail?: boolean): boolean {
  return locked && !restoredFromParkedRail
}
