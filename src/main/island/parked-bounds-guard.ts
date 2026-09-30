import { rightAnchoredParkHolds, type Rect } from './geometry'

/** Frames one park may re-commit; a native owner that keeps re-deriving the frame is not fought forever. */
const MAX_REPAIRS_PER_PARK = 4

export interface ParkedBoundsWindow {
  getBounds(): Rect
  isDestroyed(): boolean
  on(event: 'move' | 'resize', listener: () => void): unknown
  removeListener(event: 'move' | 'resize', listener: () => void): unknown
}

/**
 * The park write is a single synchronous setBounds plus readback, so a native frame change that lands
 * after it (macOS re-deriving the titled frameless window's frame from its content rect, which keeps the
 * content on the requested band and adds the title strip above it) would stay forever. While `parked()`
 * returns the rect the park wrote, every native move/resize that leaves the window off it re-commits it.
 * `parked()` returns the same object for one park, so each park has its own repair budget. `holds`
 * defaults to the right-anchored park test; `log` receives one line per re-commit.
 */
export function observeParkedBounds(
  window: ParkedBoundsWindow,
  options: {
    parked: () => Rect | null
    holds?: (actual: Rect, parked: Rect) => boolean
    commit: (parked: Rect) => void
    log?: (message: string) => void
  }
): () => void {
  let pending: ReturnType<typeof setTimeout> | null = null
  let budgetFor: Rect | null = null
  let repairs = 0

  const onNativeGeometry = (): void => {
    if (pending || window.isDestroyed() || !options.parked()) return
    // Electron emits during the native frame change; read the settled frame on the next task.
    pending = setTimeout(() => {
      pending = null
      try {
        if (window.isDestroyed()) return
        const parked = options.parked()
        const moved = window.getBounds()
        if (!parked || (options.holds ?? rightAnchoredParkHolds)(moved, parked)) return
        if (budgetFor !== parked) {
          budgetFor = parked
          repairs = 0
        }
        if (repairs >= MAX_REPAIRS_PER_PARK) return
        repairs += 1
        options.log?.(
          `[overlay-watch] re-park band from=${moved.width}x${moved.height}@(${moved.x},${moved.y}) to=${parked.width}x${parked.height}@(${parked.x},${parked.y}) after a native frame change`
        )
        options.commit(parked)
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
