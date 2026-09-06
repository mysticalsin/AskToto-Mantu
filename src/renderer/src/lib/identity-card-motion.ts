/** Spring + gesture math for the Métis member pass. Binding: docs/design/IDENTITY-CARD.md */

export const PASS_SPRING = { stiffness: 180, damping: 22 } as const
export const TILT_X = 8
export const TILT_Y = 12

export function prefersReducedMotion(query: () => boolean = matchReduced): boolean {
  try {
    return query()
  } catch {
    return false
  }
}

function matchReduced(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function stepSpring(
  pos: number,
  vel: number,
  target: number,
  dt: number,
  stiffness = PASS_SPRING.stiffness,
  damping = PASS_SPRING.damping
): { pos: number; vel: number } {
  const acc = (target - pos) * stiffness - vel * damping
  const nextVel = vel + acc * dt
  const nextPos = pos + nextVel * dt
  return { pos: nextPos, vel: nextVel }
}

/** Pointer offsets in [-1, 1] relative to the card center. */
export function tiltFromPointer(nx: number, ny: number, reduced: boolean): { rotateX: number; rotateY: number } {
  if (reduced) return { rotateX: 0, rotateY: 0 }
  const x = Math.max(-1, Math.min(1, nx))
  const y = Math.max(-1, Math.min(1, ny))
  return { rotateX: -y * TILT_X, rotateY: x * TILT_Y }
}

export function sheenFromPointer(nx: number, ny: number): { x: number; y: number } {
  const x = Math.max(-1, Math.min(1, nx))
  const y = Math.max(-1, Math.min(1, ny))
  return { x: 50 + x * 32, y: 40 + y * 28 }
}

export function normalizeDegrees(deg: number): number {
  return ((deg % 360) + 360) % 360
}

export function nearestFace(rotateY: number): 0 | 180 {
  const n = normalizeDegrees(rotateY)
  return n > 90 && n < 270 ? 180 : 0
}

export function faceFromFlip(flipped: boolean): 0 | 180 {
  return flipped ? 180 : 0
}

export function pointerNormal(clientX: number, clientY: number, rect: { left: number; width: number; top: number; height: number }): {
  nx: number
  ny: number
} {
  const nx = ((clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1
  const ny = ((clientY - rect.top) / Math.max(rect.height, 1)) * 2 - 1
  return { nx, ny }
}
