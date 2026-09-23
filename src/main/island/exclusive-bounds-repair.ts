type Rect = { x: number; y: number; width: number; height: number }

const MAX_REPAIRS_PER_UNSETTLED_EPISODE = 4
const STABLE_DWELL_MS = 1_000

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

export interface ExclusiveBoundsWindow {
  getBounds(): Rect
  setBounds(bounds: Rect, animate?: boolean): void
  setPosition(x: number, y: number, animate?: boolean): void
  isDestroyed(): boolean
  on(event: 'move' | 'resize', listener: () => void): unknown
  removeListener(event: 'move' | 'resize', listener: () => void): unknown
}

export function observeExclusiveBounds(
  window: ExclusiveBoundsWindow,
  options: { expected: () => Rect; ownsDisplay: () => boolean }
): () => void {
  let pending: ReturnType<typeof setTimeout> | null = null
  let repairing = false
  let repairAttempts = 0
  let stableSince: number | null = null

  const onNativeGeometry = (): void => {
    if (pending || repairing || window.isDestroyed() || !options.ownsDisplay()) return
    pending = setTimeout(() => {
      pending = null
      if (window.isDestroyed() || !options.ownsDisplay()) return
      try {
        const expected = options.expected()
        const actual = window.getBounds()
        if (sameRect(actual, expected)) {
          stableSince ??= Date.now()
          if (Date.now() - stableSince >= STABLE_DWELL_MS) repairAttempts = 0
          return
        }

        // An immediate setBounds readback is not proof the compositor accepted it.
        // Keep one budget across asynchronous reclamps until the bounds have
        // remained stable long enough to constitute a new episode.
        if (stableSince !== null && Date.now() - stableSince >= STABLE_DWELL_MS) {
          repairAttempts = 0
        }
        stableSince = null
        if (repairAttempts >= MAX_REPAIRS_PER_UNSETTLED_EPISODE) return
        repairAttempts += 1

        repairing = true
        try {
          window.setBounds(expected, false)
          if (!sameRect(window.getBounds(), expected)) {
            window.setBounds(expected, false)
            window.setPosition(expected.x, expected.y, false)
          }
        } finally {
          repairing = false
        }

        if (sameRect(window.getBounds(), expected)) stableSince = Date.now()
      } catch {
        // A window can be destroyed between its native event and this deferred read.
      }
    }, 0)
    pending.unref?.()
  }

  window.on('move', onNativeGeometry)
  window.on('resize', onNativeGeometry)
  return () => {
    if (pending) clearTimeout(pending)
    pending = null
    window.removeListener('move', onNativeGeometry)
    window.removeListener('resize', onNativeGeometry)
  }
}
