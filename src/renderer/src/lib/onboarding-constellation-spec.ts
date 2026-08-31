/**
 * Purple constellation-grid bed — docs/design/ONBOARDING-STARFIELD.md.
 * Pure: no canvas, no DOM. Engine and tests both import from here.
 */

export const GRID = {
  spacing: 55,
  mouseRadius: 220,
  springK: 18,
  damping: 0.82,
  linkDist: 75,
  dprCap: 2,
  bg: '#05010a',
  bgDeep: '#030407',
  node: '#7F00DA',
  line: '#9A2BF0',
  ring: '#C084FC',
  highlight: '#C084FC'
} as const

export const CONSTELLATION_SEED_DT = 1 / 60
export const CONSTELLATION_CROSSFADE_MS = 640

/** After Next. Not hero (April 29 girl clip). No skip scene. */
export const CONSTELLATION_SCENES = [
  'problem',
  'reveal',
  'setup',
  'personalize',
  'license',
  'ready'
] as const

export type ConstellationScene = (typeof CONSTELLATION_SCENES)[number]

export function shouldMountConstellation(scene: string): boolean {
  return (CONSTELLATION_SCENES as readonly string[]).includes(scene)
}

/** Retired. Three.js starfield / torus must not mount after hero. */
export function shouldMountStarfield(_scene: string): boolean {
  return false
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const n = hex.replace('#', '')
  return {
    r: parseInt(n.slice(0, 2), 16),
    g: parseInt(n.slice(2, 4), 16),
    b: parseInt(n.slice(4, 6), 16)
  }
}

export function clampDt(dtSeconds: number): number {
  if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return CONSTELLATION_SEED_DT
  return Math.min(0.05, Math.max(1 / 120, dtSeconds))
}

export function hookeAccel(rest: number, current: number, k: number): number {
  return (rest - current) * k
}

export function recedeForce(dist: number, radius: number): number {
  if (dist <= 0 || dist >= radius) return 0
  return 1 - dist / radius
}

export function linkAlpha(dist: number, linkDist: number): number {
  if (dist <= 0 || dist >= linkDist) return 0
  return 1 - dist / linkDist
}
