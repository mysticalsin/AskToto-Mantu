/**
 * Bounded-concurrency map (Q05 / D8-6). Whole-brain reads used to open every entity file at once with an
 * unbounded `Promise.all`, spiking file handles and memory with the size of the brain. This keeps at most
 * `limit` calls in flight and returns results in input order.
 *
 * `stop`, when given, is checked before each new item starts: once it returns true no further item is
 * taken, items already running still finish, and the slots of items never started stay `undefined`.
 * A rejection ends the run: nothing new starts and the first error is thrown.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  stop?: () => boolean
): Promise<Array<R | undefined>> {
  const results = new Array<R | undefined>(items.length).fill(undefined)
  let next = 0
  let failed = false
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length && !stop?.()) {
      const index = next
      next += 1
      try {
        results[index] = await fn(items[index], index)
      } catch (error) {
        failed = true
        throw error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return results
}
