/** The Electron powerMonitor events that withdraw or restore the right to look at the screen. */
export type ScreenLifecycleEvent = 'lock-screen' | 'unlock-screen' | 'suspend' | 'resume'

export interface ScreenLifecycleSource {
  on(event: ScreenLifecycleEvent, listener: () => void): unknown
}

export interface ScreenLifecycleSink {
  noteScreenLocked(locked: boolean): void
  noteSuspended(suspended: boolean): void
}

/**
 * Subscribe the screen observation to the OS lock and sleep signals: locking or suspending drops pending
 * capture work, and nothing is captured until the screen is unlocked and the machine is awake again.
 * Returns false (and warns) when a subscription is refused; it never throws, because the app has to start.
 */
export function installScreenObservationLifecycle(
  source: ScreenLifecycleSource,
  sink: ScreenLifecycleSink,
  log: { warn(message: string): void }
): boolean {
  try {
    source.on('lock-screen', () => sink.noteScreenLocked(true))
    source.on('unlock-screen', () => sink.noteScreenLocked(false))
    source.on('suspend', () => sink.noteSuspended(true))
    source.on('resume', () => sink.noteSuspended(false))
    return true
  } catch (error) {
    log.warn(
      `[screen-observation] lock and sleep signals unavailable: ${error instanceof Error ? error.message : String(error)}`
    )
    return false
  }
}
