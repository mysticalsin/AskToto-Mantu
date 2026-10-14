export async function waitForAppliedFrontiers(options: {
  deadline: number
  currentDeadline?(): number
  subscribeDeadline?(wake: () => void): () => void
  now(): number
  isApplied(): boolean
  isFailed(): boolean
  waiters: Set<() => void>
}): Promise<boolean> {
  while (!options.isApplied()) {
    const remaining = Math.min(options.deadline, options.currentDeadline?.() ?? options.deadline) - options.now()
    if (remaining <= 0) return false
    let wake!: () => void
    const waiter = new Promise<void>((resolve) => {
      wake = resolve
    })
    options.waiters.add(wake)
    const unsubscribeDeadline = options.subscribeDeadline?.(wake)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, remaining)
    })
    await Promise.race([waiter, timeout])
    options.waiters.delete(wake)
    unsubscribeDeadline?.()
    if (timer) clearTimeout(timer)
    if (options.isFailed()) return false
  }
  return true
}
