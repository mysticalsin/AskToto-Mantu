/**
 * Settings feature module for spoken replies (G27, CAP-18). Spread into BaseSettingsSchema so ipc.ts grows by one
 * spread, not by the feature's fields, and listed in settings-registry.ts (the G09 convention).
 *
 * Owner rule (NEEDS_TONY 2026-10-21 18:05 and 19:30): a feature that depends on hardware (here, the audio output)
 * ships ON only after the owner's physical checklist passes. Until then spoken replies are a Preview feature that is
 * OFF by default, so `speakReplies` is a plain boolean that defaults to false; no build turns it on for anyone.
 * Decision D-13: the engine is the platform's on-device voice (macOS AVSpeechSynthesizer, Windows SAPI), so there is
 * no vendor, no key and no cloud text-to-speech setting here.
 */
import { z } from 'zod'
import { defineSettingsFeature } from './settings-feature-module'

export const SPEECH_RATE_MIN = 0.5
export const SPEECH_RATE_MAX = 1.5
export const SPEECH_RATE_DEFAULT = 1

/** The playback rate multiplier, clamped to 0.5 to 1.5. Anything that is not a finite number is the normal rate. */
export function clampSpeechRate(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return SPEECH_RATE_DEFAULT
  return Math.min(SPEECH_RATE_MAX, Math.max(SPEECH_RATE_MIN, value))
}

export const SpokenRepliesSettingsSchema = z.object({
  /** Read Métis answers aloud. OFF until the owner's checklist passes; the answer text is on screen either way. */
  speakReplies: z.boolean().default(false),
  /** An id from the approved voice list. `null` selects the first approved installed voice. */
  voiceId: z.string().max(200).nullable().default(null),
  /** Playback speed multiplier. A bad stored value is clamped, never a reason to drop the whole settings file. */
  rate: z.unknown().transform(clampSpeechRate).default(SPEECH_RATE_DEFAULT)
})
export type SpokenRepliesSettings = z.infer<typeof SpokenRepliesSettingsSchema>

export const DEFAULT_SPOKEN_REPLIES_SETTINGS: SpokenRepliesSettings = {
  speakReplies: false,
  voiceId: null,
  rate: SPEECH_RATE_DEFAULT
}

export const SPOKEN_REPLIES_FEATURE = defineSettingsFeature({
  id: 'spoken-replies',
  shape: { spokenReplies: SpokenRepliesSettingsSchema.default(DEFAULT_SPOKEN_REPLIES_SETTINGS) }
})
