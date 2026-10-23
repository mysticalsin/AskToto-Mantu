import { describe, expect, it } from 'vitest'
import { DEFAULT_VOICE_ACTIONS_SETTINGS, VoiceActionsSettingsSchema } from '../voice-actions-settings'
import {
  CONVERSATION_RELEASE_DEFAULT_ON,
  DEFAULT_CONVERSATION_SETTINGS,
  resolveConversationEnabled
} from './conversation-options'

describe('conversation settings (G28)', () => {
  it('a profile saved before conversation existed loads with the conversation defaults', () => {
    const parsed = VoiceActionsSettingsSchema.parse({ enabled: true })
    expect(parsed.conversation).toEqual(DEFAULT_CONVERSATION_SETTINGS)
    expect(parsed.conversation.enabled).toBeNull()
    expect(DEFAULT_VOICE_ACTIONS_SETTINGS.conversation).toEqual(DEFAULT_CONVERSATION_SETTINGS)
  })

  it('is a Preview feature: OFF in release builds, ON in QA builds, an explicit choice always wins', () => {
    expect(CONVERSATION_RELEASE_DEFAULT_ON).toBe(false)
    const fresh = DEFAULT_CONVERSATION_SETTINGS
    expect(resolveConversationEnabled(fresh, { qaIdentity: false })).toBe(false)
    expect(resolveConversationEnabled(fresh, { qaIdentity: true })).toBe(true)
    expect(resolveConversationEnabled({ enabled: true }, { qaIdentity: false })).toBe(true)
    expect(resolveConversationEnabled({ enabled: false }, { qaIdentity: true })).toBe(false)
    expect(resolveConversationEnabled(fresh, { qaIdentity: false, releaseDefaultOn: true })).toBe(true)
    expect(resolveConversationEnabled(undefined, { qaIdentity: false })).toBe(false)
  })
})
