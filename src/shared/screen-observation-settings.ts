import { z } from 'zod'
import { defineSettingsFeature } from './settings-feature-module'

/**
 * Screen observation settings (G16, R-11). A hover must not capture the screen: the capture starts on the
 * explicit Ask. The hover or press pre-capture is kept only as an opt-in latency trade, off by default, and
 * IT can lock it like any other key in managed config.
 */
export const ScreenObservationSettingsShape = {
  /** Allow the Capture button's hover or press to take a frame ahead of the click. */
  screenHoverPrewarm: z.boolean().default(false)
}

export const SCREEN_OBSERVATION_SETTINGS_DEFAULTS = { screenHoverPrewarm: false }

export const SCREEN_OBSERVATION_FEATURE = defineSettingsFeature({
  id: 'screen-observation',
  shape: ScreenObservationSettingsShape
})
