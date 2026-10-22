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

/**
 * THE release flag. Flip this to `true` (one line) once the owner's physical checklist passes (the chord in
 * another app, VoiceOver, AltGr, focus restore, microphone prompt). QA-identity builds are ON regardless.
 */
export const VOICE_ACTIONS_RELEASE_DEFAULT_ON = false

/**
 * Modifier tokens the hold watcher understands. Modifier-only: a hold of letter keys would need key
 * identities, which the watcher protocol deliberately never carries. `l`/`r` prefixes name one physical side.
 */
export const VOICE_CHORD_TOKENS = [
  'control',
  'option',
  'command',
  'shift',
  'fn',
  'lcontrol',
  'rcontrol',
  'loption',
  'roption',
  'lcommand',
  'rcommand',
  'lshift',
  'rshift',
  'lalt',
  'ralt',
  'lwin',
  'rwin'
] as const
export type VoiceChordToken = (typeof VOICE_CHORD_TOKENS)[number]

const ChordSchema = z.array(z.enum(VOICE_CHORD_TOKENS)).min(1).max(4)

export const VoiceActionsSettingsSchema = z.object({
  /** `null` follows the build default (QA on, release per VOICE_ACTIONS_RELEASE_DEFAULT_ON). */
  enabled: z.boolean().nullable().default(null),
  /** Hold-to-talk chord per platform. Default: Right Command (macOS) and Right Control (Windows). */
  holdChord: z.object({ mac: ChordSchema.default(['rcommand']), win: ChordSchema.default(['rcontrol']) }).default({
    mac: ['rcommand'],
    win: ['rcontrol']
  }),
  /** Optional "Hey Métis" listening. Off by default; gated by the wake measurement in V07. */
  wakeWord: z.boolean().default(false),
  /** How many times the first-use hint has been shown (V05). */
  firstUseHintsShown: z.number().int().min(0).max(1000).default(0)
})
export type VoiceActionsSettings = z.infer<typeof VoiceActionsSettingsSchema>

export const DEFAULT_VOICE_ACTIONS_SETTINGS: VoiceActionsSettings = {
  enabled: null,
  holdChord: { mac: ['rcommand'], win: ['rcontrol'] },
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
