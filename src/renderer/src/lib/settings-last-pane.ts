/**
 * settings-last-pane.ts — Settings reopens on the pane the person last viewed (Apple HIG, Settings: "restore the
 * most recently viewed pane"). A per-device convenience, so it lives in this renderer's localStorage and every
 * read and write tolerates storage being unavailable; an unknown or missing value falls back to the default pane.
 */
const LAST_PANE_KEY = 'metis.settings.lastPane'

type PaneStorage = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): PaneStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function readLastSettingsPane<T extends string>(
  panes: readonly T[],
  storage: PaneStorage | null = defaultStorage()
): T | null {
  try {
    const value = storage?.getItem(LAST_PANE_KEY)
    return value && (panes as readonly string[]).includes(value) ? (value as T) : null
  } catch {
    return null
  }
}

export function writeLastSettingsPane(pane: string, storage: PaneStorage | null = defaultStorage()): void {
  try {
    storage?.setItem(LAST_PANE_KEY, pane)
  } catch {
    // Storage full or blocked: the next open simply starts on the default pane.
  }
}
