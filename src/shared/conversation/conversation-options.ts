/**
 * Conversation options (G28), the `voiceActions.conversation` part of the settings. Like dictation, they live
 * inside the `voiceActions` settings object (a registered owner, a managed-policy lock and a settings page) so no
 * new top-level key lands in the ratcheted `ipc.ts`.
 *
 * Owner rule (NEEDS_TONY 2026-10-21 19:30): a feature that depends on hardware (the microphone, speakers) ships ON
 * only after the owner's physical checklist passes. Until then continuous conversation is a Preview feature: ON in
 * QA-identity builds and OFF in release builds. `enabled` is tri-state: `null` follows the build default, an
 * explicit boolean is the person's or the organization's choice and wins. Conversation also needs voice actions
 * (its utterances are voice turns), which the runtime checks; this switch alone never opens a microphone.
 */
import { z } from 'zod'

/** THE release flag for continuous conversation. Flip it (one line) once the owner's physical checklist passes. */
export const CONVERSATION_RELEASE_DEFAULT_ON = false

export const ConversationSettingsSchema = z.object({
  /** `null` follows the build default (QA on, release per CONVERSATION_RELEASE_DEFAULT_ON). */
  enabled: z.boolean().nullable().default(null)
})
export type ConversationSettings = z.infer<typeof ConversationSettingsSchema>

export const DEFAULT_CONVERSATION_SETTINGS: ConversationSettings = { enabled: null }

/** Whether continuous conversation is on for this build and profile. Pure: the caller names the build. */
export function resolveConversationEnabled(
  stored: Pick<ConversationSettings, 'enabled'> | undefined,
  build: { qaIdentity: boolean; releaseDefaultOn?: boolean }
): boolean {
  if (typeof stored?.enabled === 'boolean') return stored.enabled
  return build.qaIdentity || (build.releaseDefaultOn ?? CONVERSATION_RELEASE_DEFAULT_ON)
}
