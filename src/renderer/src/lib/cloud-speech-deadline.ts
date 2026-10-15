export async function bounded<T>(
  operation: Promise<T>,
  deadline: number,
  now: () => number,
  timeoutValue: T
): Promise<T> {
  const remaining = deadline - now()
  if (remaining <= 0) return timeoutValue
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(timeoutValue), remaining)
  })
  try {
    return await Promise.race([operation, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function boundedCall<T>(
  operation: () => Promise<T>,
  deadline: number,
  now: () => number,
  timeoutValue: T
): Promise<T> {
  if (deadline - now() <= 0) return timeoutValue
  return bounded(operation(), deadline, now, timeoutValue)
}

export function createAdjustableDeadline(now: () => number) {
  let deadline: number | null = null
  const waiters = new Set<() => void>()

  return {
    current(): number | null {
      return deadline
    },

    shorten(next: number): void {
      if (deadline !== null && next >= deadline) return
      deadline = next
      for (const wake of [...waiters]) wake()
    },

    subscribe(wake: () => void): () => void {
      waiters.add(wake)
      return () => waiters.delete(wake)
    },

    bounded<T>(operation: Promise<T>, fallbackDeadline: number, timeoutValue: T): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        let settled = false
        const finish = (complete: () => void): void => {
          if (settled) return
          settled = true
          if (timer) clearTimeout(timer)
          waiters.delete(schedule)
          complete()
        }
        const schedule = (): void => {
          if (timer) clearTimeout(timer)
          const remaining = Math.min(deadline ?? fallbackDeadline, fallbackDeadline) - now()
          if (remaining <= 0) {
            finish(() => resolve(timeoutValue))
            return
          }
          timer = setTimeout(() => finish(() => resolve(timeoutValue)), remaining)
        }
        waiters.add(schedule)
        schedule()
        operation.then(
          (value) => finish(() => resolve(value)),
          (error: unknown) => finish(() => reject(error))
        )
      })
    }
  }
}
