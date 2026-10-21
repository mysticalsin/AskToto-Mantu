/** The permission helper's timers (C32 Part D): its status poll while open, and the checkmark's close delay. */
export function startPermissionHelperPoll(read: () => void, everyMs: number): () => void {
  const timer = setInterval(read, everyMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

export function afterPermissionHelperDelay(run: () => void, ms: number): () => void {
  const timer = setTimeout(run, ms)
  return () => clearTimeout(timer)
}
