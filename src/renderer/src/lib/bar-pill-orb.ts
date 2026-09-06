/**
 * Bar / minimized pill circle: Jakub thinking-orb on Métis dark glass.
 * Idle solving. Listen listening. Think working. Theme dark.
 * Package canvas is the 64 avatar with a 2x backing store.
 * Visible CSS circle is 41 (20% off the previous 51). No 1x CSS downscale.
 * No painted caption. Real package. No WebGL marble.
 */

import type { OrbState } from 'thinking-orbs'

/** Package avatar preset. Do not pass a third canvas size to ThinkingOrb. */
export const BAR_PILL_SIZE_PX = 64
/** On-screen circle before this shrink. Take 20% off this, not off 64. */
export const BAR_PILL_FROM_VISIBLE_PX = 51
/** Visible Bar circle / hit target. 51 × 0.8. Not the package inline 20. */
export const BAR_PILL_VISIBLE_PX = Math.round(BAR_PILL_FROM_VISIBLE_PX * 0.8)
export const BAR_PILL_WIDTH_PX = BAR_PILL_VISIBLE_PX
export const BAR_PILL_HEIGHT_PX = BAR_PILL_VISIBLE_PX
/** 2x avatar backing. Do not CSS-downscale a 1x 64 bitmap into the 41 hole. */
export const BAR_PILL_BACKING_DPR = 2
export const BAR_PILL_BACKING_PX = BAR_PILL_SIZE_PX * BAR_PILL_BACKING_DPR
/** Left Settings M. Locked square. Listen chrome must not squash this. */
export const BAR_MARK_SIZE_PX = 30

/** Backing DPR for the Bar orb. Always at least 2x the 64 avatar. */
export function barOrbBackingDpr(devicePixelRatio = 1): number {
  const reported = Math.min(BAR_PILL_BACKING_DPR, devicePixelRatio || 1)
  return Math.max(BAR_PILL_BACKING_DPR, reported)
}

export const ORB_MOODS = ['idle', 'thinking', 'factcheck', 'connecting'] as const
export type OrbMood = (typeof ORB_MOODS)[number]
export type BarPillOrbMood = OrbMood

/** Package avatar preset. Do not invent a third size. */
export const BAR_ORB_THEME = 'dark' as const
export const BAR_ORB_SPEED = 1

export const ORB_STATE: Record<OrbMood, OrbState> = {
  idle: 'solving',
  thinking: 'working',
  factcheck: 'searching',
  connecting: 'connecting'
}

/** Package default labels. Must never paint on the Bar pill. */
export const ORB_PAINTED_WORDS = [
  'Solving…',
  'Listening…',
  'Working…',
  'Breathing…',
  'Searching…',
  'Connecting…',
  'Thinking…',
  'Weaving…',
  'Composing…',
  'Shaping…'
] as const

export function sliceBarOrbMarkup(html: string): string {
  const token = 'data-bar-pill-orb'
  const at = html.indexOf(token)
  if (at < 0) return ''
  const start = html.lastIndexOf('<button', at)
  const end = html.indexOf('</button>', at)
  if (start < 0 || end < 0) return ''
  return html.slice(start, end + '</button>'.length)
}

/** True if markup paints a playground caption/label (aria-label and title may stay). */
export function orbHostPaintsText(html: string): boolean {
  const host = sliceBarOrbMarkup(html) || html
  const stripped = host
    .replace(/aria-label="[^"]*"/g, '')
    .replace(/title="[^"]*"/g, '')
    .replace(/<canvas\b[^>]*>/g, '')
  if (ORB_PAINTED_WORDS.some((word) => stripped.includes(word))) return true
  return />(Solving|Listening|Working|Breathing)</.test(stripped)
}

export function isFixedCircle(width: number, height: number): boolean {
  return width === height && width === BAR_PILL_VISIBLE_PX
}

export function orbBoxForMood(_mood: OrbMood): { width: number; height: number } {
  return { width: BAR_PILL_VISIBLE_PX, height: BAR_PILL_VISIBLE_PX }
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

/** Expand Métis on Circle/Jarvis. Fires onActivate when this press was not a drag. */
export function runOrbPillActivate(input: {
  enableDrag?: boolean
  dragMoved: boolean
  onActivate: () => void
}): boolean {
  if (input.enableDrag && !pillClickShouldExpand(input.dragMoved)) return false
  input.onActivate()
  return true
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
