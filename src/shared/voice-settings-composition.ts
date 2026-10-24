/**
 * The voice, quiet-mode (G68) and screen-observation feature settings share one schema/default spread in ipc.ts. Their individual feature modules remain
 * registered separately so ownership and migrations stay specific to each feature.
 */
import { DEFAULT_VOICE_ACTIONS_SETTINGS, VOICE_ACTIONS_FEATURE } from './voice-actions-settings'
import { DEFAULT_SPOKEN_REPLIES_SETTINGS, SPOKEN_REPLIES_FEATURE } from './spoken-replies-settings'
import { QUIET_MODE_FEATURE, QUIET_SETTINGS_DEFAULTS } from './quiet-mode-settings'
import { SCREEN_OBSERVATION_FEATURE, SCREEN_OBSERVATION_SETTINGS_DEFAULTS } from './screen-observation-settings'
import { DEFAULT_SUGGESTIONS_SETTINGS, SUGGESTIONS_FEATURE } from './suggestions-settings'
import { LIVE_TRANSLATION_FEATURE, LIVE_TRANSLATION_SETTINGS_DEFAULTS } from './live-translation-settings'

export const VOICE_SETTINGS_SHAPE = {
  ...SUGGESTIONS_FEATURE.shape,
  ...LIVE_TRANSLATION_FEATURE.shape,
  ...VOICE_ACTIONS_FEATURE.shape,
  ...SPOKEN_REPLIES_FEATURE.shape,
  ...QUIET_MODE_FEATURE.shape,
  ...SCREEN_OBSERVATION_FEATURE.shape
}

export const DEFAULT_VOICE_SETTINGS = {
  ...DEFAULT_SUGGESTIONS_SETTINGS,
  ...LIVE_TRANSLATION_SETTINGS_DEFAULTS,
  voiceActions: DEFAULT_VOICE_ACTIONS_SETTINGS,
  spokenReplies: DEFAULT_SPOKEN_REPLIES_SETTINGS,
  ...QUIET_SETTINGS_DEFAULTS,
  ...SCREEN_OBSERVATION_SETTINGS_DEFAULTS
}
