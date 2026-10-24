import { z } from 'zod'
import { defineSettingsFeature } from './settings-feature-module'

/**
 * Proactive controls (G77): when Métis may put a card up without being asked. Two modes today; a third
 * (`key-moments`) waits for the G74 classifier route and is added here as an enum value when it can be honoured.
 */
export const INTERRUPTION_MODES = ['manual', 'questions'] as const
export const InterruptionModeSchema = z.enum(INTERRUPTION_MODES)
export type InterruptionMode = z.infer<typeof InterruptionModeSchema>

export const DEFAULT_INTERRUPTION_MODE: InterruptionMode = 'questions'

export const PROACTIVE_SETTINGS_DEFAULTS = { interruptionMode: DEFAULT_INTERRUPTION_MODE }

export const PROACTIVE_CONTROLS_FEATURE = defineSettingsFeature({
  id: 'proactive-controls',
  shape: { interruptionMode: InterruptionModeSchema.default(DEFAULT_INTERRUPTION_MODE) }
})
