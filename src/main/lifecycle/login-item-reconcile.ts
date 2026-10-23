/**
 * login-item-reconcile.ts — boot-time launch-at-login reconcile where the OS is the authority (G85/CAP-38).
 *
 * If the person turned Métis off in System Settings (or Windows Startup apps) while our setting says on, we never
 * silently turn it back on: the cached OS read already makes Settings show the switch off with the "open System
 * Settings" copy (loginItemView). We only ever switch the OS item OFF, to match a saved "off".
 * Returns true when the OS state differs from the saved setting so Settings can refresh.
 */
export interface LoginItemReconcileArgs {
  want: boolean
  /** Refreshes the cache and returns what the OS says now; null when the OS cannot be read. */
  readOs: () => boolean | null
  setOs: (openAtLogin: boolean) => void
}

export function reconcileLoginItem({ want, readOs, setOs }: LoginItemReconcileArgs): boolean {
  const current = readOs()
  if (current === null || current === want) return false
  if (!want) {
    setOs(false)
    readOs() // refresh the cache with what the OS did
  }
  return true
}
