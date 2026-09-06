/**
 * Synthetic cursor geometry (Act 2 Demo) — the pure easing/interpolation math behind the onboarding
 * demo's own drawn cursor (see components/OnboardingDemoScene.tsx). Split out for the same reason
 * lib/scramble.ts's `scrambleFrame` is: the actual measurement (getBoundingClientRect on the target
 * chip) needs a real DOM and isn't unit-testable in this repo's node-only vitest environment, but the
 * "where along the path is the cursor at progress p" question has nothing to do with the DOM at all —
 * it is pure interpolation over two points, and is exactly the part worth pinning with tests.
 */

export interface Point {
  x: number
  y: number
}

/** Ease-out cubic — starts fast, settles gently into the target, like a hand reaching for a button
 *  rather than a robot snapping to a coordinate. Matches the "physical motion" brief without needing an
 *  animation library: a plain polynomial. */
export function easeOutCubic(p: number): number {
  const c = p <= 0 ? 0 : p >= 1 ? 1 : p
  return 1 - Math.pow(1 - c, 3)
}

/** The cursor's position at a given linear `progress` (0..1) moving from `from` to `to`, eased. A slight
 *  upward arc (peaking mid-path) is added on the y-axis only — a straight line reads as a slide, a small
 *  arc reads as a hand lifting and landing, at zero extra state (purely a function of progress). */
export function cursorPositionAt(progress: number, from: Point, to: Point, arcPx = 18): Point {
  const eased = easeOutCubic(progress)
  const clamped = progress <= 0 ? 0 : progress >= 1 ? 1 : progress
  // Parabolic arc: 0 at both ends, peaks (arcPx) at the midpoint.
  const arc = arcPx * 4 * clamped * (1 - clamped)
  return {
    x: from.x + (to.x - from.x) * eased,
    y: from.y + (to.y - from.y) * eased - arc
  }
}
