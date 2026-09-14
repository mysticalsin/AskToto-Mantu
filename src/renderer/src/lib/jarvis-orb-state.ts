/**
 * Pure Jarvis orb state helpers — no Three.js.
 * Kept separate so ObsidianOrb can resolve mood without pulling WebGL into the boot chunk.
 */
import type { OrbMood } from './bar-pill-orb'

export const JARVIS_ORB_STATES = ['idle', 'listening', 'thinking', 'speaking'] as const
export type JarvisOrbState = (typeof JARVIS_ORB_STATES)[number]

export function isJarvisOrbState(v: unknown): v is JarvisOrbState {
  return v === 'idle' || v === 'listening' || v === 'thinking' || v === 'speaking'
}

export function resolveJarvisOrbState(input: { mood: OrbMood; listening?: boolean }): JarvisOrbState {
  if (input.listening) return 'listening'
  if (input.mood === 'thinking' || input.mood === 'factcheck' || input.mood === 'connecting') {
    return 'thinking'
  }
  return 'idle'
}
