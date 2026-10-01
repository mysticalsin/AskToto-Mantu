/**
 * Keeps the overlay's process out of App Nap while the overlay is shown (M2-0518).
 *
 * The boot hold (FITO-185-B) ends with the 15 s boot watch and the meeting hold only covers a recording, so
 * an idle, shown overlay could be napped: its timers and IPC then ran late with the machine otherwise calm.
 * `prevent-app-suspension` keeps the process at normal priority and the system out of idle sleep while it is
 * held; the display may still sleep.
 *
 * Invariants:
 *   - The hold is started while the window is visible and stopped when it hides or closes.
 *   - One blocker per window, separate from the boot and meeting blockers, never started twice.
 */

/** The slice of Electron's powerSaveBlocker the hold uses. */
export interface SuspensionBlocker {
  start(type: 'prevent-app-suspension'): number
  stop(id: number): void
  isStarted(id: number): boolean
}

/** The slice of BrowserWindow the hold reads. */
export interface SuspensionHoldWindow {
  isDestroyed(): boolean
  isVisible(): boolean
  on(event: 'show' | 'hide' | 'closed', listener: () => void): unknown
}

export function holdAppSuspensionWhileVisible(win: SuspensionHoldWindow, blocker: SuspensionBlocker): void {
  let id: number | null = null
  const start = (): void => {
    if (id !== null && blocker.isStarted(id)) return
    id = blocker.start('prevent-app-suspension')
  }
  const stop = (): void => {
    if (id === null) return
    if (blocker.isStarted(id)) blocker.stop(id)
    id = null
  }
  win.on('show', start)
  win.on('hide', stop)
  win.on('closed', stop)
  if (!win.isDestroyed() && win.isVisible()) start()
}
