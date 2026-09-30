export interface ParkMinimumSizeWindow {
  getMinimumSize(): number[]
  setMinimumSize(width: number, height: number): void
}

/**
 * Releases a leftover larger minimum size (Settings) before a Hide park. An unchanged 1×1 is never re-written:
 * every minimum-size write re-applies the native size constraints of the frameless (still titled) macOS overlay,
 * and AppKit applies the resulting frame change on a later pass, after the park, re-deriving the frame from the
 * content rect with the 32 px title strip added above the band (M2-0526).
 */
export function releaseParkMinimumSize(window: ParkMinimumSizeWindow): void {
  try {
    const [width, height] = window.getMinimumSize()
    if (width !== 1 || height !== 1) window.setMinimumSize(1, 1)
  } catch {
    /* headless */
  }
}
