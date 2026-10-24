import { z } from 'zod'
import { defineSettingsFeature } from './settings-feature-module'

export const QUIET_MODE_OPTIONS = ['off', 'calls-and-screen-sharing', 'always'] as const
export const QuietModeSchema = z.enum(QUIET_MODE_OPTIONS)
export type QuietMode = z.infer<typeof QuietModeSchema>

export const DEFAULT_QUIET_MODE: QuietMode = 'calls-and-screen-sharing'

/** Ambient suggestions and nudges are quiet-gated; direct owner requests are never suppressed. */
export const QuietSettingsShape = { quietMode: QuietModeSchema.default(DEFAULT_QUIET_MODE) }
export const QUIET_SETTINGS_DEFAULTS = { quietMode: DEFAULT_QUIET_MODE }
export const QUIET_MODE_FEATURE = defineSettingsFeature({ id: 'quiet-mode', shape: QuietSettingsShape })

export const QUIET_OUTPUT_CHANNELS = ['toast', 'sound', 'spokenReply', 'proactiveSuggestion', 'autoAnswerCard'] as const
export const QuietOutputChannelSchema = z.enum(QUIET_OUTPUT_CHANNELS)
export type QuietOutputChannel = z.infer<typeof QuietOutputChannelSchema>
export type QuietAction = 'allow' | 'defer' | 'drop'
export type QuietPolicy = Record<QuietOutputChannel, QuietAction>
export interface QuietDeferredBatch {
  channels: QuietOutputChannel[]
  startedAtMs: number
  releasedAtMs: number
}
