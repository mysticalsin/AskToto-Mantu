import type { ShortcutFailure } from '@shared/ipc'
import { displayAccelerator } from './keys'
import { SHORTCUT_LABELS } from './shortcut-labels'

/** Stable identity of a failure set, independent of order. */
function failureKey(failures: readonly ShortcutFailure[]): string {
  return failures
    .map((f) => `${f.action}\u0000${f.accel}`)
    .sort()
    .join('\u0001')
}

/** The overlay toast copy for a failed registration (D10-5), or null when nothing failed. */
export function shortcutFailureMessage(
  failures: readonly ShortcutFailure[],
  format: (accelerator: string) => string = displayAccelerator
): string | null {
  const [first] = failures
  if (!first) return null
  const labels: Record<string, string> = SHORTCUT_LABELS
  const named = `${labels[first.action] ?? first.action} shortcut ${format(first.accel)}`
  if (failures.length === 1) {
    return `${named} is used by another app. Choose a different one in Settings → Shortcuts.`
  }
  return `${named} and ${failures.length - 1} more are used by another app. Choose different ones in Settings → Shortcuts.`
}

/** Returns the toast copy the first time a failure set is seen in this session and null afterwards. */
export function createShortcutFailureAnnouncer(
  format?: (accelerator: string) => string
): (failures: readonly ShortcutFailure[]) => string | null {
  const seen = new Set<string>()
  return (failures) => {
    if (!failures.length) return null
    const key = failureKey(failures)
    if (seen.has(key)) return null
    seen.add(key)
    return shortcutFailureMessage(failures, format)
  }
}
