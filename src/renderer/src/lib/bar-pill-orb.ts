/**
 * Bar / minimized pill circle: Jakub thinking-orb on Métis dark glass.
 * Idle breathing. Listen listening. Think working. Size 64. Theme dark.
 * Real package. No WebGL marble. No Fit Studio magenta core.
 */

import type { OrbState } from 'thinking-orbs'

export const BAR_PILL_SIZE_PX = 64
export const BAR_PILL_WIDTH_PX = BAR_PILL_SIZE_PX
export const BAR_PILL_HEIGHT_PX = BAR_PILL_SIZE_PX

export const ORB_MOODS = ['idle', 'thinking', 'factcheck', 'connecting'] as const
export type OrbMood = (typeof ORB_MOODS)[number]
export type BarPillOrbMood = OrbMood

/** Package avatar preset. Do not invent a third size. */
export const BAR_ORB_THEME = 'dark' as const
export const BAR_ORB_SPEED = 1

export const ORB_STATE: Record<OrbMood, OrbState> = {
  idle: 'breathing',
  thinking: 'working',
  factcheck: 'searching',
  connecting: 'connecting'
}

export function isFixedCircle(width: number, height: number): boolean {
  return width === height && width === BAR_PILL_SIZE_PX
}

export function orbBoxForMood(_mood: OrbMood): { width: number; height: number } {
  return { width: BAR_PILL_SIZE_PX, height: BAR_PILL_SIZE_PX }
}

export function orbAspectRatio(width = BAR_PILL_WIDTH_PX, height = BAR_PILL_HEIGHT_PX): number {
  return height === 0 ? 0 : width / height
}

export function resolveOrbMood(input: {
  connecting?: boolean
  factcheck?: boolean
  thinking?: boolean
}): OrbMood {
  if (input.connecting) return 'connecting'
  if (input.factcheck) return 'factcheck'
  if (input.thinking) return 'thinking'
  return 'idle'
}

/**
 * Product mood + listen flag → thinking-orbs state.
 * connecting > listening > factcheck > thinking > idle.
 */
export function resolveBarOrbState(input: { mood: OrbMood; listening?: boolean }): OrbState {
  if (input.mood === 'connecting') return 'connecting'
  if (input.listening) return 'listening'
  return ORB_STATE[input.mood]
}

/** Listen is the listening orb. A second red disc fights that state. */
export function shouldShowOrbRecDot(_listening = false): boolean {
  return false
}

/** Click expands. A real drag must not. */
export function pillClickShouldExpand(didDrag: boolean): boolean {
  return !didDrag
}

/**
 * Orb clock is allowed only on a mounted Bar circle (docked idle or minimized rest).
 * Hide, Island, reduced-motion, and a hidden document must not run a frame loop we own.
 */
export function shouldRunOrbRaf(input: {
  minimized: boolean
  barLayout: boolean
  reducedMotion: boolean
  documentHidden: boolean
}): boolean {
  void input.minimized
  return input.barLayout && !input.reducedMotion && !input.documentHidden
}

export function shouldAnimateOrb(reducedMotion: boolean): boolean {
  return !reducedMotion
}
