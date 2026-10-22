/**
 * Dictation options (G22), the `voiceActions.dictation` part of the settings. They live inside the `voiceActions` settings object (`voiceActions.dictation`), not in a
 * key of their own: `voiceActions` already has a registered owner, a managed-policy lock and a settings page, and a
 * new top-level key would add lines to the ratcheted `ipc.ts`. Dictation is still independent of voice actions: its
 * own switch, its own chord, its own default.
 *
 * Owner rule (NEEDS_TONY 2026-10-21 19:30): a feature that depends on hardware (a global modifier hold, the
 * microphone) ships ON only after the owner's physical checklist passes. Until then dictation is a Preview feature:
 * ON in QA-identity builds and OFF in release builds. `enabled` is tri-state like voice actions: `null` follows the
 * build default, an explicit boolean is the person's or the organization's choice and wins.
 */
import { z } from 'zod'
import { VOICE_CHORD_TOKENS, voiceChordMask, type VoiceChordToken } from './voice/chord-tokens'

/**
 * THE release flag for dictation. Flip it to `true` (one line) once the owner's physical checklist passes (the
 * chord in another app, the target field, focus change, secure fields). QA-identity builds are ON regardless.
 */
export const DICTATION_RELEASE_DEFAULT_ON = false

const ChordSchema = z.array(z.enum(VOICE_CHORD_TOKENS)).min(1).max(4)

/**
 * Default dictation chords.
 * macOS: Left Control + Fn (the Clicky default Fn+Control, PROVIDED by the 2.12 spec).
 * Windows: Left Ctrl + Left Alt. PROPOSED and unconfirmed on real hardware: it differs from the voice hold default
 * (Right Ctrl alone), so neither chord's partial press can arm the other, and it is not AltGr (which Windows reports
 * as Left Ctrl + Right Alt), so no layout types a character with it.
 */
export const DICTATION_CHORD_DEFAULTS: { mac: VoiceChordToken[]; win: VoiceChordToken[] } = {
  mac: ['leftControl', 'fn'],
  win: ['leftControl', 'leftAlt']
}

export const DictationSettingsSchema = z.object({
  /** `null` follows the build default (QA on, release per DICTATION_RELEASE_DEFAULT_ON). */
  enabled: z.boolean().nullable().default(null),
  /** Dictation chord per platform. Configurable; the Windows default is PROPOSED. */
  chord: z
    .object({
      mac: ChordSchema.default(DICTATION_CHORD_DEFAULTS.mac),
      win: ChordSchema.default(DICTATION_CHORD_DEFAULTS.win)
    })
    .default(DICTATION_CHORD_DEFAULTS),
  /** Hands-free dictation by a quick double press of the chord (the Clicky gesture). On by default. */
  handsFreeLatch: z.boolean().default(true)
})
export type DictationSettings = z.infer<typeof DictationSettingsSchema>

export const DEFAULT_DICTATION_SETTINGS: DictationSettings = {
  enabled: null,
  chord: { mac: [...DICTATION_CHORD_DEFAULTS.mac], win: [...DICTATION_CHORD_DEFAULTS.win] },
  handsFreeLatch: true
}

/** Whether dictation is on for this build and profile. Pure: the caller names the build. */
export function resolveDictationEnabled(
  stored: Pick<DictationSettings, 'enabled'> | undefined,
  build: { qaIdentity: boolean; releaseDefaultOn?: boolean }
): boolean {
  if (typeof stored?.enabled === 'boolean') return stored.enabled
  return build.qaIdentity || (build.releaseDefaultOn ?? DICTATION_RELEASE_DEFAULT_ON)
}

/**
 * The dictation chord as the watcher's modifier mask for a platform; 0 when the platform has no hold watcher or when
 * the chord equals the voice hold chord. One hold can never mean two things, so a clash switches dictation's chord
 * off (the caller then runs no helper for it) rather than letting two features race for the same activation.
 */
export function resolveDictationChordMask(
  stored: { dictation?: Pick<DictationSettings, 'chord'> } | undefined,
  platform: NodeJS.Platform,
  voiceHoldMask: number
): number {
  const chord = stored?.dictation?.chord ?? DEFAULT_DICTATION_SETTINGS.chord
  const tokens = platform === 'darwin' ? chord.mac : platform === 'win32' ? chord.win : []
  const mask = voiceChordMask(tokens)
  return mask !== 0 && mask === voiceHoldMask ? 0 : mask
}

/** The double-press latch for dictation (hands-free). */
export function resolveDictationLatch(stored: Pick<DictationSettings, 'handsFreeLatch'> | undefined): boolean {
  return stored?.handsFreeLatch ?? DEFAULT_DICTATION_SETTINGS.handsFreeLatch
}
