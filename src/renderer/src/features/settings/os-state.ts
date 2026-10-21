/**
 * os-state.ts — Settings toggles that depend on the operating system show what the OS will actually do (Apple HIG,
 * Settings and Privacy), re-checked whenever Métis becomes active again, with a one-line reason and an
 * "Open System Settings" button when the OS refuses.
 */
import { useCallback, useEffect, useState } from 'react'
import type { LoginItemOsState, NotificationOsState, SettingsOsState } from '@shared/contracts/settings-os-state'

/** The OS state, read when Settings mounts and again each time the window regains focus. */
export function useSettingsOsState(): { osState: SettingsOsState | null; refreshOsState: () => Promise<void> } {
  const [osState, setOsState] = useState<SettingsOsState | null>(null)
  const refreshOsState = useCallback(async (): Promise<void> => {
    try {
      setOsState(await window.toto.settingsOsState())
    } catch {
      // Keep the last known state; the toggle falls back to the app's own cached value.
    }
  }, [])
  useEffect(() => {
    void refreshOsState()
    const onFocus = (): void => void refreshOsState()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refreshOsState])
  return { osState, refreshOsState }
}

export type OsToggleView = { on: boolean; hint: string | null }

/**
 * Launch at login. `wanted` is the saved preference, `cached` main's last OS read (PublicSettings), `os` a fresh
 * read when available. The switch shows the OS truth; a refusal of a wanted login item gets the reason.
 */
export function loginItemView(wanted: boolean, cached: boolean, os: LoginItemOsState | null | undefined): OsToggleView {
  if (!os?.supported) return { on: cached, hint: null }
  if (os.requiresApproval) {
    return { on: false, hint: 'macOS needs your approval before Métis can open at login.' }
  }
  if (wanted && !os.enabled) return { on: false, hint: "macOS didn't add Métis to your login items." }
  return { on: os.enabled, hint: null }
}

/** Meeting alerts: on only when wanted and the OS lets Métis post notifications at all. */
export function notificationsView(wanted: boolean, os: NotificationOsState | null | undefined): OsToggleView {
  if (!os || os.supported) return { on: wanted, hint: null }
  return { on: false, hint: "This computer isn't letting Métis show notifications." }
}
