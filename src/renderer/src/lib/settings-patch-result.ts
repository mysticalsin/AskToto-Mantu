/**
 * settings-patch-result.ts — a settings write answered with what actually happened.
 *
 * settings:set resolves with the full snapshot even when main drops a key (managed policy, schema refusal), and
 * throws when the profile cannot be written. A field that needs to explain a refusal inline (Apple HIG, Settings:
 * invalid input is validated next to the field) asks through this helper instead of trusting the call to succeed.
 */
import type { PublicSettings } from '@shared/ipc'

export type SettingsPatchResult = { ok: true } | { ok: false; reason: 'refused' | 'failed'; message: string }

/** `patch` is the Settings patch function; one that resolves nothing (a test double) counts as accepted. */
export async function patchSettingsChecked<K extends keyof PublicSettings>(
  patch: (p: Partial<PublicSettings>) => Promise<PublicSettings> | void,
  next: Pick<PublicSettings, K>
): Promise<SettingsPatchResult> {
  let saved: PublicSettings | void
  try {
    saved = await patch(next)
  } catch {
    // Main's own messages can carry file paths; the field shows a plain sentence instead.
    return { ok: false, reason: 'failed', message: "Métis couldn't save this change. Try again." }
  }
  if (!saved) return { ok: true }
  for (const key of Object.keys(next) as K[]) {
    if (saved[key] !== next[key]) {
      return {
        ok: false,
        reason: 'refused',
        message: "Métis didn't accept this value. The previous one is still in use."
      }
    }
  }
  return { ok: true }
}
