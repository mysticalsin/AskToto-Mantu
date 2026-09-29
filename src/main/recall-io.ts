import { unlink, writeFile } from 'node:fs/promises'

// The fs and cache primitives behind recall.ts. recall.ts reads only through the storage gateway and
// touches no node:fs itself; the few writes it makes (delete a meeting, rewrite index.md) live here.

/** Removes one file; rejects with the fs error (callers branch on `code`). */
export function removeFile(path: string): Promise<void> {
  return unlink(path)
}

export function writeTextFile(path: string, text: string): Promise<void> {
  return writeFile(path, text, 'utf8')
}

/** A least-recently-used map: a full cache evicts its single oldest entry, never everything at once, so a
 *  library one file over the cap keeps almost all of its warm entries. */
export class Lru<V> {
  private readonly entries = new Map<string, V>()

  constructor(private readonly max: number) {}

  get(key: string): V | undefined {
    const value = this.entries.get(key)
    if (value === undefined) return undefined
    this.entries.delete(key)
    this.entries.set(key, value)
    return value
  }

  set(key: string, value: V): void {
    this.entries.delete(key)
    this.entries.set(key, value)
    if (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value as string)
  }

  delete(key: string): void {
    this.entries.delete(key)
  }

  get size(): number {
    return this.entries.size
  }
}
