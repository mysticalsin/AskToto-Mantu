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

/** Subscribe to display removal: a frame or pending capture of a display that is gone cannot be trusted. */
export function installDisplayRemovalRevocation(
  source: { on(event: 'display-removed', listener: () => void): unknown },
  observation: { revoke(reason: 'display-removed'): unknown },
  log: { warn(message: string): void }
): boolean {
  try {
    source.on('display-removed', () => observation.revoke('display-removed'))
    return true
  } catch (error) {
    log.warn(
      `[screen-observation] display removal signal unavailable: ${error instanceof Error ? error.message : String(error)}`
    )
    return false
  }
}

/** Install both signals at boot: lock and sleep drop pending captures, and a removed display drops its captures. */
export function installScreenObservationSignals(
  power: ScreenLifecycleSource,
  display: { on(event: 'display-removed', listener: () => void): unknown },
  observation: ScreenLifecycleSink & { revoke(reason: 'display-removed'): unknown },
  log: { warn(message: string): void }
): void {
  installScreenObservationLifecycle(power, observation, log)
  installDisplayRemovalRevocation(display, observation, log)
}
