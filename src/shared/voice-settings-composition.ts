/**
 * The voice feature settings share one schema/default spread in ipc.ts. Their individual feature modules remain
 * registered separately so ownership and migrations stay specific to each feature.
 */
import { DEFAULT_VOICE_ACTIONS_SETTINGS, VOICE_ACTIONS_FEATURE } from './voice-actions-settings'
import { DEFAULT_SPOKEN_REPLIES_SETTINGS, SPOKEN_REPLIES_FEATURE } from './spoken-replies-settings'

export const VOICE_SETTINGS_SHAPE = {
  ...VOICE_ACTIONS_FEATURE.shape,
  ...SPOKEN_REPLIES_FEATURE.shape
}

export const DEFAULT_VOICE_SETTINGS = {
  voiceActions: DEFAULT_VOICE_ACTIONS_SETTINGS,
  spokenReplies: DEFAULT_SPOKEN_REPLIES_SETTINGS
}
