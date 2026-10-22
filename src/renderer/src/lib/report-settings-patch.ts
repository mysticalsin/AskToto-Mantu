/**
 * report-settings-patch.ts — Settings' `patch` with one place that says a write failed (Apple HIG, Settings: a
 * change that could not be saved is explained, never reverted without a word).
 *
 * `settings:set` rejects when the profile cannot be written. Most switches and selects call `patch(...)` and
 * never look at the result, so the rejection was unhandled and the control just snapped back. The wrapper tells
 * Settings once, in plain words (main's own message can carry a file path), and returns the SAME promise, so a
 * caller that awaits it still sees the failure and keeps its own error handling. The wrapper attaches its own
 * handler to that promise, so a caller that ignores the result leaves no unhandled rejection behind.
 */
import type { PublicSettings } from '@shared/ipc'

export const SETTINGS_SAVE_FAILED_MESSAGE = "Métis couldn't save this change. Try again."

type Patch = (p: Partial<PublicSettings>) => Promise<PublicSettings>

/** A `patch` whose failures are reported; `unreported` is the raw one for a field that explains a failure itself. */
export type ReportingPatch = Patch & { unreported: Patch }

/**
 * `report(message)` is called with the sentence after a rejected write and with `null` after a write that went
 * through, so the line clears on the next success.
 */
export function reportingPatch(patch: Patch, report: (message: string | null) => void): ReportingPatch {
  const reporting = ((next: Partial<PublicSettings>): Promise<PublicSettings> => {
    const write = patch(next)
    void Promise.resolve(write).then(
      () => report(null),
      () => report(SETTINGS_SAVE_FAILED_MESSAGE)
    )
    return write
  }) as ReportingPatch
  reporting.unreported = patch
  return reporting
}

/** The write a field should use when it reports failures next to itself: the raw one when `patch` is wrapped. */
export function unreportedPatch<T extends (p: Partial<PublicSettings>) => Promise<PublicSettings> | void>(patch: T): T {
  return (patch as T & { unreported?: T }).unreported ?? patch
}

/** The overlay-opacity slider's value text; its accessible name stays fixed ("Overlay transparency"). */
export function overlayOpacityStatus(opacity: number): string {
  return opacity < 0.9 ? 'More transparent' : opacity > 1.1 ? 'Less transparent' : 'Default'
}
