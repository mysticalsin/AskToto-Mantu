/**
 * Decision logic of the packaged Windows launch gate, kept free of I/O so fixture title sequences can
 * exercise it.
 *
 * Electron titles a new window with the package name until the renderer's <title> loads, so an early
 * sample such as ["asktoto"] is a healthy slow start, not a verdict. The only terminal states are a
 * window titled after the product, a native "Error" dialog, the process exiting, or the deadline.
 */

/** @returns {'healthy' | 'error-dialog' | 'exited' | 'timeout' | 'pending'} */
export function launchVerdict({ titles, exited, deadlinePassed }) {
  // A real showErrorBox dialog wins over a product-titled window: the app reported that it is broken.
  if (titles.some((t) => /^Error$/i.test(t))) return 'error-dialog'
  if (titles.some((t) => /M.tis/i.test(t))) return 'healthy'
  if (exited) return 'exited'
  if (deadlinePassed) return 'timeout'
  return 'pending'
}
