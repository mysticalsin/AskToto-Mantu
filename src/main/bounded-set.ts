/**
 * A Set that forgets its oldest members past `max`. For "already notified this session" style
 * de-duplication keys that otherwise accumulate for the whole life of a process that is meant to run for
 * days (calendar events, import jobs). Insertion order is the eviction order; re-adding an existing key
 * does not refresh it (the semantics are "seen once", not LRU).
 */
export class BoundedSet<T> {
  private readonly set = new Set<T>()

  constructor(readonly max: number) {
    if (!Number.isInteger(max) || max < 1) throw new RangeError('BoundedSet max must be a positive integer')
  }

  has(value: T): boolean {
    return this.set.has(value)
  }

  add(value: T): this {
    if (this.set.has(value)) return this
    this.set.add(value)
    while (this.set.size > this.max) {
      const oldest = this.set.values().next()
      if (oldest.done) break
      this.set.delete(oldest.value)
    }
    return this
  }

  delete(value: T): boolean {
    return this.set.delete(value)
  }

  clear(): void {
    this.set.clear()
  }

  get size(): number {
    return this.set.size
  }
}
