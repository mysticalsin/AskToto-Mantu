/**
 * Settings feature module for the read-only research and suggestion pipeline (G67, CAP-32). Spread into
 * BaseSettingsSchema through voice-settings-composition.ts and listed in settings-registry.ts (the G09 convention).
 *
 * Off by default (ASSUMED, privacy-first): until the owner turns it on, no source is read for suggestions and neither a
 * manual check nor a routine does anything.
 */
import { z } from 'zod'
import { defineSettingsFeature } from './settings-feature-module'

export const SUGGESTIONS_FEATURE = defineSettingsFeature({
  id: 'suggestions',
  shape: { suggestionsEnabled: z.boolean().default(false) }
})
export const DEFAULT_SUGGESTIONS_SETTINGS = { suggestionsEnabled: false }
