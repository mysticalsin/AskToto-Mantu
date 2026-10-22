/**
 * A least-recently-used cache bounded by entry count AND by the bytes its entries hold, for History's read
 * cache: every cached meeting keeps its decrypted, public-projected text, so a count limit alone let a large
 * library keep tens of megabytes of transcript text resident in the main process. A Map iterates in insertion
 * order, so re-inserting on every hit keeps the coldest entry first.
 */
interface Entry<V> {
  value: V
  bytes: number
}

export class ByteBudgetCache<V> {
  private readonly entries = new Map<string, Entry<V>>()
  private readonly maxEntries: number
  private readonly maxBytes: number
  private total = 0

  constructor(maxEntries: number, maxBytes: number) {
    this.maxEntries = maxEntries
    this.maxBytes = maxBytes
  }

  get size(): number {
    return this.entries.size
  }

  /** The bytes the cached entries are accounted at. */
  get bytes(): number {
    return this.total
  }

  /** The cached value, now the warmest entry. */
  get(key: string): V | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  delete(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    this.total -= entry.bytes
  }

  /** Caches `value` at `bytes`, then drops the coldest entries until both limits hold. One entry larger than the
   *  whole budget is not kept (and replaces nothing: the older value under that key is dropped as stale). */
  set(key: string, value: V, bytes: number): void {
    this.delete(key)
    if (bytes > this.maxBytes) return
    this.entries.set(key, { value, bytes })
    this.total += bytes
    while (this.total > this.maxBytes || this.entries.size > this.maxEntries) {
      const coldest = this.entries.keys().next().value as string
      this.delete(coldest)
    }
  }
}

/** History's decrypted-text budget: about 200 hour-long meetings stay warm, the rest are read again. */
export const READ_CACHE_MAX_BYTES = 32 * 1024 * 1024
