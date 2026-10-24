import { z } from 'zod'
import { defineSettingsFeature } from './settings-feature-module'

export const LIVE_TRANSLATION_TARGETS = ['off', 'en', 'fr', 'pt-BR', 'es'] as const
export const LiveTranslationTargetSchema = z.enum(LIVE_TRANSLATION_TARGETS)
export type LiveTranslationTarget = z.infer<typeof LiveTranslationTargetSchema>

/** Default off: nothing is translated, nothing is sent, until the user picks a language (G73). */
export const DEFAULT_LIVE_TRANSLATION_TARGET: LiveTranslationTarget = 'off'

export const LiveTranslationSettingsShape = {
  liveTranslationTarget: LiveTranslationTargetSchema.default(DEFAULT_LIVE_TRANSLATION_TARGET)
}
export const LIVE_TRANSLATION_SETTINGS_DEFAULTS = { liveTranslationTarget: DEFAULT_LIVE_TRANSLATION_TARGET }
export const LIVE_TRANSLATION_FEATURE = defineSettingsFeature({
  id: 'live-translation',
  shape: LiveTranslationSettingsShape
})
