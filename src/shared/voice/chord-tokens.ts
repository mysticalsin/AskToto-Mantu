/**
 * The chord vocabulary shared by the hold-to-talk setting (V02) and the dictation chord (G22): the hold watcher's
 * own modifier names (`MODIFIER_BITS` in modifier-mask.ts), so the settings, the recognizer and the helpers all
 * speak one language. Modifier-only: a hold of letter keys would need key identities, which the helper protocol
 * deliberately never carries. `unsided` is a protocol value, never a chord.
 */
import { MODIFIER_BITS } from './modifier-mask'

export const VOICE_CHORD_TOKENS = [
  'leftControl',
  'rightControl',
  'leftAlt',
  'rightAlt',
  'leftCommand',
  'rightCommand',
  'leftShift',
  'rightShift',
  'fn'
] as const satisfies ReadonlyArray<Exclude<keyof typeof MODIFIER_BITS, 'unsided'>>
export type VoiceChordToken = (typeof VOICE_CHORD_TOKENS)[number]

/** The chord as the watcher's modifier mask (the tokens or-ed together); 0 for no tokens. */
export function voiceChordMask(chord: readonly VoiceChordToken[]): number {
  return chord.reduce((mask, token) => mask | MODIFIER_BITS[token], 0)
}
