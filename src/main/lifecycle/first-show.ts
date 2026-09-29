/** The slice of BrowserWindow the first-show scheduler reads. */
export interface FirstShowWindow {
  isDestroyed(): boolean
  once(event: 'ready-to-show', listener: () => void): unknown
  removeListener(event: 'ready-to-show', listener: () => void): unknown
}

/** M2-0031: the boot overlay is constructed hidden and shown by this, so the native construction and the
 *  native first show never share one main-thread task. `show` runs at most once, never before this returns,
 *  on whichever comes first: the next task (setImmediate) or 'ready-to-show'. It is never gated on renderer
 *  JS or a load event, so Act 1 still appears as soon as the window exists. A destroyed window is not shown. */
export function scheduleFirstShow(win: FirstShowWindow, show: () => void): void {
  let done = false
  const run = (): void => {
    if (done) return
    done = true
    clearImmediate(immediate)
    win.removeListener('ready-to-show', run)
    if (win.isDestroyed()) return
    show()
  }
  const immediate = setImmediate(run)
  win.once('ready-to-show', run)
}
