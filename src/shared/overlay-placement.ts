/**
 * A physical placement preference for the Métis overlay. This is deliberately
 * independent of `overlay-chrome`: chrome decides how the rest state looks;
 * placement decides where its window belongs.
 */
export const OVERLAY_PLACEMENTS = ['top-center', 'right-edge'] as const
export type OverlayPlacement = (typeof OVERLAY_PLACEMENTS)[number]

/** Legacy profiles and malformed values keep the established top-center behavior. */
export function parseOverlayPlacement(value: unknown): OverlayPlacement {
  return value === 'right-edge' ? 'right-edge' : 'top-center'
}

/**
 * Local-only key for one Electron display. It is intentionally an opaque OS
 * display id rather than hardware metadata, so normalized placement state
 * never stores a serial number, model name, or desktop coordinate. Electron
 * uses non-positive ids for invalid/virtual display results on some paths;
 * those must never become durable placement records.
 */
export function overlayDisplayKey(displayId: number): string | null {
  if (!Number.isSafeInteger(displayId) || displayId <= 0) return null
  return `display:${displayId}`
}
