/** Owns one cancellable monotonic-deadline wakeup for a live speech capture. */
export type CaptureDeadlineScheduler = (run: () => void, delayMs: number) => () => void

export const scheduleCaptureDeadline: CaptureDeadlineScheduler = (run, delayMs) => {
  const timer = setTimeout(run, Math.max(0, delayMs))
  timer.unref?.()
  return () => clearTimeout(timer)
}
