/** One cancellable wakeup that ends a connector confirm card at its lifetime (G64). Never keeps the process alive. */
export type ConfirmDeadlineScheduler = (run: () => void, delayMs: number) => () => void

export const scheduleConfirmDeadline: ConfirmDeadlineScheduler = (run, delayMs) => {
  const timer = setTimeout(run, Math.max(0, delayMs))
  timer.unref?.()
  return () => clearTimeout(timer)
}
