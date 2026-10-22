/**
 * Settings feature module for voice actions (V02). Spread into BaseSettingsSchema so ipc.ts grows by one
 * spread, not by the feature's fields, and listed in settings-registry.ts (the G09 convention).
 *
 * Owner decision (NEEDS_TONY 2026-10-21 18:05 and 19:30): voice actions are ON by default, but a feature
 * that depends on hardware (a global modifier hold, the microphone) ships ON only after the owner's physical
 * checklist passes. Until then the effective default is ON in QA builds and OFF ("Preview") in release builds.
 * `enabled` is therefore tri-state: `null` means "follow the build default", an explicit boolean is the user's
 * or the organization's choice and always wins. A managed `voiceActions` key (managed-config) locks the whole
 * object through the generic store policy, so no extra plumbing is needed here.
 */
import { z } from 'zod'
import { defineSettingsFeature } from './settings-feature-module'
import { MODIFIER_BITS } from './voice/modifier-mask'

/**
 * THE release flag. Flip this to `true` (one line) once the owner's physical checklist passes (the chord in
 * another app, VoiceOver, AltGr, focus restore, microphone prompt). QA-identity builds are ON regardless.
 */
export const VOICE_ACTIONS_RELEASE_DEFAULT_ON = false

/**
 * The "Hey Métis" gate (design section 4). The sub-toggle in Settings stays off, and says why, until V07's
 * measurement (false accepts, true accepts, CPU, latency, memory on reference hardware) passes and this flips.
 */
export const VOICE_WAKE_WORD_GATE_PASSED = false

/**
 * Chord tokens are the hold watcher's own modifier names (`MODIFIER_BITS` in voice/modifier-mask.ts): one
 * vocabulary for the setting, the recognizer and the helpers. Modifier-only: a hold of letter keys would need key
 * identities, which the helper protocol deliberately never carries. `unsided` is a protocol value, never a chord.
 */
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

const ChordSchema = z.array(z.enum(VOICE_CHORD_TOKENS)).min(1).max(4)

export const VoiceActionsSettingsSchema = z.object({
  /** `null` follows the build default (QA on, release per VOICE_ACTIONS_RELEASE_DEFAULT_ON). */
  enabled: z.boolean().nullable().default(null),
  /** Hold-to-talk chord per platform. Default: Right Command (macOS) and Right Control (Windows). */
  holdChord: z
    .object({ mac: ChordSchema.default(['rightCommand']), win: ChordSchema.default(['rightControl']) })
    .default({ mac: ['rightCommand'], win: ['rightControl'] }),
  /**
   * Hands-free listening by a quick double press of the chord. OFF by default: a double press of Right Command is
   * the macOS Dictation shortcut for many people. The option stays for those who can't hold a key.
   */
  doublePressLatch: z.boolean().default(false),
  /** Optional "Hey Métis" listening. Off by default; gated by the wake measurement in V07. */
  wakeWord: z.boolean().default(false),
  /** How many times the first-use hint has been shown (V05). */
  firstUseHintsShown: z.number().int().min(0).max(1000).default(0)
})
export type VoiceActionsSettings = z.infer<typeof VoiceActionsSettingsSchema>

export const DEFAULT_VOICE_ACTIONS_SETTINGS: VoiceActionsSettings = {
  enabled: null,
  holdChord: { mac: ['rightCommand'], win: ['rightControl'] },
  doublePressLatch: false,
  wakeWord: false,
  firstUseHintsShown: 0
}

export const VOICE_ACTIONS_FEATURE = defineSettingsFeature({
  id: 'voice-actions',
  shape: { voiceActions: VoiceActionsSettingsSchema.default(DEFAULT_VOICE_ACTIONS_SETTINGS) }
})

/** Whether voice actions are on for this build and profile. Pure: the caller names the build. */
export function resolveVoiceActionsEnabled(
  stored: Pick<VoiceActionsSettings, 'enabled'> | undefined,
  build: { qaIdentity: boolean; releaseDefaultOn?: boolean }
): boolean {
  if (typeof stored?.enabled === 'boolean') return stored.enabled
  return build.qaIdentity || (build.releaseDefaultOn ?? VOICE_ACTIONS_RELEASE_DEFAULT_ON)
}

/** The hold chord for a platform; empty on a platform that has no hold watcher. */
export function resolveVoiceActionsChord(
  stored: Pick<VoiceActionsSettings, 'holdChord'> | undefined,
  platform: NodeJS.Platform
): readonly VoiceChordToken[] {
  const chord = stored?.holdChord ?? DEFAULT_VOICE_ACTIONS_SETTINGS.holdChord
  return platform === 'darwin' ? chord.mac : platform === 'win32' ? chord.win : []
}

/** The chord as the watcher's modifier mask (the tokens or-ed together); 0 when the platform has no chord. */
export function voiceChordMask(chord: readonly VoiceChordToken[]): number {
  return chord.reduce((mask, token) => mask | MODIFIER_BITS[token], 0)
}
