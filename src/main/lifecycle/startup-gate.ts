/**
 * startup-gate.ts — the first thing a launch does, before any window, microphone, sidecar or usage event (G85/CAP-38).
 *
 *  1. Minimum OS (D-26): on an unsupported OS show the honest sentence once and quit; no lock, no user data touched.
 *  2. Single instance: take the lock; the losing launch quits having created nothing, and the running instance
 *     only receives the second launch's argv (reveal + deeplink handoff), never a second boot.
 *
 * Returns true when this launch may continue booting.
 */
import { evaluatePlatformSupport } from '../../shared/platform-support'

export interface StartupApp {
  requestSingleInstanceLock(): boolean
  quit(): void
  on(
    event: 'second-instance',
    listener: (event: unknown, commandLine: string[], workingDirectory: string) => void
  ): unknown
}

export interface ClaimStartupArgs {
  app: StartupApp
  dialog: { showErrorBox(title: string, content: string): void }
  platform?: NodeJS.Platform
  systemVersion?: string
  /** A second launch focuses the existing window... */
  reveal: () => void
  /** ...and forwards only its argv (smoke probe, deeplink handoff); it never boots anything. */
  argv: (commandLine: readonly string[]) => unknown
}

export function claimStartup({
  app,
  dialog,
  platform = process.platform,
  systemVersion = process.getSystemVersion?.(),
  reveal,
  argv
}: ClaimStartupArgs): boolean {
  const support = evaluatePlatformSupport(platform, systemVersion)
  if (!support.supported) {
    try {
      dialog.showErrorBox('Métis can’t open', support.message)
    } catch {
      /* no display to show it on; still quit */
    }
    app.quit()
    return false
  }
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return false
  }
  app.on('second-instance', (_event, commandLine) => {
    reveal()
    argv(commandLine)
  })
  return true
}
