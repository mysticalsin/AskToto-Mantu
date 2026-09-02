/**
 * KineticGrid contract — docs/design/ONBOARDING-KINETIC-GRID.md.
 * Pure: no canvas, no DOM. Host and tests both import from here.
 */

export const KINETIC_COLORS = {
  bg: '#05010a',
  bgDeep: '#1A0033',
  lineActive: '#7F00DA',
  nodeActive: '#9A2BF0',
  glow: '#9A2BF0',
  ripple: '#7F00DA',
  lineBase: 'rgba(196, 132, 252, 0.16)'
} as const

export const KINETIC_DPR_CAP = 2
export const KINETIC_CELL = 28
export const KINETIC_MOUSE_LERP = 0.12
export const KINETIC_WARP_RADIUS = 140
export const KINETIC_WARP_STRENGTH = 18
export const KINETIC_EDGE_PIN_PX = 56
export const KINETIC_RIPPLE_SPEED = 220
export const KINETIC_RIPPLE_WAVELENGTH = 48
export const KINETIC_RIPPLE_LIFE = 1.15

export const KINETIC_GRID_SCENES = [
  'problem',
  'reveal',
  'setup',
  'personalize',
  'license',
  'appearance',
  'ready'
] as const

export type KineticGridScene = (typeof KINETIC_GRID_SCENES)[number]

/** After the lady beat. Never on hero. There is no skip scene. */
export function shouldMountKineticGrid(scene: string): boolean {
  return (KINETIC_GRID_SCENES as readonly string[]).includes(scene)
}

export function lerp2(
  current: { x: number; y: number },
  target: { x: number; y: number },
  t: number
): { x: number; y: number } {
  return {
    x: current.x + (target.x - current.x) * t,
    y: current.y + (target.y - current.y) * t
  }
}

/** 0 at the canvas edge, 1 in the interior. Edge cells stay pinned. */
export function edgePinFactor(
  cx: number,
  cy: number,
  width: number,
  height: number,
  pinPx = KINETIC_EDGE_PIN_PX
): number {
  if (width <= 0 || height <= 0 || pinPx <= 0) return 1
  const dx = Math.min(cx, width - cx)
  const dy = Math.min(cy, height - cy)
  const inset = Math.min(dx, dy)
  return Math.max(0, Math.min(1, inset / pinPx))
}

export function tileWarp(input: {
  cx: number
  cy: number
  mx: number
  my: number
  width: number
  height: number
  radius?: number
  strength?: number
}): { dx: number; dy: number; falloff: number } {
  const radius = input.radius ?? KINETIC_WARP_RADIUS
  const strength = input.strength ?? KINETIC_WARP_STRENGTH
  const ox = input.cx - input.mx
  const oy = input.cy - input.my
  const dist = Math.hypot(ox, oy)
  const raw = dist >= radius || radius <= 0 ? 0 : 1 - dist / radius
  const falloff = raw * raw * edgePinFactor(input.cx, input.cy, input.width, input.height)
  if (falloff <= 0) return { dx: 0, dy: 0, falloff: 0 }
  const inv = dist > 1e-6 ? 1 / dist : 0
  return { dx: ox * inv * strength * falloff, dy: oy * inv * strength * falloff, falloff }
}

/** Expanding ring. 0 when idle or expired. */
export function rippleOffset(input: {
  cx: number
  cy: number
  ox: number
  oy: number
  ageSec: number
  amplitude?: number
}): number {
  if (input.ageSec < 0 || input.ageSec > KINETIC_RIPPLE_LIFE) return 0
  const dist = Math.hypot(input.cx - input.ox, input.cy - input.oy)
  const ring = input.ageSec * KINETIC_RIPPLE_SPEED
  const band = (dist - ring) / KINETIC_RIPPLE_WAVELENGTH
  const envelope = Math.exp(-input.ageSec * 2.2) * (1 - input.ageSec / KINETIC_RIPPLE_LIFE)
  const amp = input.amplitude ?? 10
  return Math.sin(band * Math.PI * 2) * envelope * amp
}

export function kineticPixelRatio(devicePixelRatio: number): number {
  if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) return 1
  return Math.min(devicePixelRatio, KINETIC_DPR_CAP)
}
