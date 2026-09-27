/**
 * Every deliberate way this process ends, each routed through one stopAll() (infra/process/stop-all.ts).
 *
 * app.quit() reaches will-quit, where the listener installed here stops every owned child. app.exit() skips
 * before-quit and will-quit, so the two paths that call it, the emergency hard exit and the relaunch after a
 * fatal error, run stopAll() themselves, immediately before app.exit(). This module holds the only
 * app.exit() calls in src/main. Nothing here waits for a child: SIGKILL needs no confirmation, and a quitting
 * process must never hang on one.
 */

/** The part of Electron's `app` the exit paths drive. */
export interface ExitApp {
  on(event: 'will-quit', listener: () => void): unknown
  quit(): void
  exit(exitCode: number): void
  relaunch(): void
}

export interface ExitPathDeps {
  /** Stop every owned child process. */
  stopAll: () => void
  /** Mark this exit as deliberate, so the next boot does not count it as an early death. */
  closeBootWatch: () => void
  warn: (...args: unknown[]) => void
}

export interface ExitPaths {
  /** The emergency quit (Cmd+Ctrl+Esc and the tray item). It is polite first: before-quit still flushes a live
   *  meeting. It exits hard after the grace, or at once on a second press. */
  forceQuit: () => void
  /** Exit now and start a fresh instance (onFatal's "Relaunch Métis"). A fatal is not a deliberate exit, so the
   *  boot watch stays open: a fatal during boot still counts as an early death. */
  exitAndRelaunch: () => void
}

/** before-quit gives a live meeting 2 s to flush, so the emergency quit stays polite for longer than that. Past
 *  it, politeness is the bug: a wedged renderer never answers the flush and can keep the quit from completing. */
const EMERGENCY_FORCE_QUIT_GRACE_MS = 4000

/**
 * Register the will-quit teardown and build the two app.exit() paths. index.ts calls this once, at module top
 * level, so this will-quit listener is the first: a throwing listener registered later cannot skip it.
 */
export function installExitPaths(app: ExitApp, { stopAll, closeBootWatch, warn }: ExitPathDeps): ExitPaths {
  app.on('will-quit', () => stopAll())

  const hardExit = (): void => {
    stopAll()
    try {
      closeBootWatch()
    } catch (error) {
      warn('[force-quit] closing the boot watch failed', error)
    }
    app.exit(0)
  }

  let watchdog: NodeJS.Timeout | null = null
  return {
    forceQuit: () => {
      // A second press means the first one did not get the process down. Stop asking.
      if (watchdog) {
        warn('[lifecycle] emergency quit pressed again — exiting now')
        hardExit()
        return
      }
      warn('[lifecycle] emergency graceful quit requested')
      app.quit()
      watchdog = setTimeout(() => {
        warn('[lifecycle] graceful quit did not complete — forcing exit')
        hardExit()
      }, EMERGENCY_FORCE_QUIT_GRACE_MS)
      // The watchdog must never be the handle that keeps a quitting process alive.
      watchdog.unref()
    },
    exitAndRelaunch: () => {
      stopAll()
      app.relaunch()
      app.exit(0)
    }
  }
}
