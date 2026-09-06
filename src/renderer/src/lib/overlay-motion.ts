/**
 * Hide/reveal spring timings — one surface, compositor-only (transform + opacity).
 * Window bounds change once on reveal and once after the hide spring (park).
 */

/** Reveal spring (ms). Window is already at islandSafeTop before this plays. */
export const OVERLAY_REVEAL_MS = 360
/** Hide reverse spring (ms). Park happens after this, not on the hide tick. */
export const OVERLAY_HIDE_MS = 320
/** If animationend is missed, park anyway so the bar cannot stick open. */
export const OVERLAY_PARK_FALLBACK_MS = 400

export type OverlaySpring = 'rest' | 'in' | 'settled' | 'out'

export function overlaySpringAfterReveal(reducedMotion: boolean): OverlaySpring {
  return reducedMotion ? 'settled' : 'in'
}

/** Reduced-motion hides instantly and should park on the same turn. */
export function overlaySpringAfterHide(reducedMotion: boolean): OverlaySpring {
  return reducedMotion ? 'rest' : 'out'
}

export function overlayShouldParkNow(spring: OverlaySpring, reducedMotion: boolean): boolean {
  return reducedMotion || spring === 'out'
}

export function prefersOverlayReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Island peek only when fully parked. Hide keeps Bar mounted (window size is the park)
 * so top-edge restoreBarWidth shows Ask immediately — Ultron a40a22f: 880×44
 * buttons=[Show Métis] hasAsk=false after unmounting Bar for OverlayPeek.
 */
export function overlayShowPeek(
  idle: boolean,
  revealed: boolean,
  spring: OverlaySpring,
  keepAskMounted = false
): boolean {
  if (keepAskMounted) return false
  return idle && !revealed && spring === 'rest'
}

export function overlaySpringClassName(spring: OverlaySpring): string {
  if (spring === 'in') return 'overlay-spring overlay-spring--in w-full'
  if (spring === 'out') return 'overlay-spring overlay-spring--out w-full'
  if (spring === 'settled') return 'overlay-spring overlay-spring--settled w-full'
  return 'w-full'
}
