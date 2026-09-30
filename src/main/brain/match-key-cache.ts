/**
 * match-key-cache.ts — Receipt Mode's entity-slug match index, isolated so store.ts writers can
 * invalidate without importing context.ts (which already imports store — a cycle would soft-deadlock
 * module init and leave the cache permanently stale). This module is filesystem-only: no store import.
 *
 * Hot path on every answer ask: one async directory stat against the cached mtime. Writers call
 * `invalidateMatchKeyDir` so an alias edit never waits on filesystem mtime resolution.
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export type DirStamp = { mtimeMs: number; count: number; sizeSum: number }
export type MatchKeyEntry = { slug: string; keys: string[] }
export type MatchKeyCacheEntry = { stamp: DirStamp; entries: MatchKeyEntry[] }

const matchKeyCache = new Map<string, MatchKeyCacheEntry>()

export function getMatchKeyCache(): Map<string, MatchKeyCacheEntry> {
  return matchKeyCache
}

export async function entityDirMtime(dir: string): Promise<number> {
  try {
    return (await stat(dir)).mtimeMs
  } catch {
    return -1
  }
}

export async function entityDirStamp(dir: string): Promise<DirStamp> {
  try {
    const mtimeMs = (await stat(dir)).mtimeMs
    let count = 0
    let sizeSum = 0
    for (const f of await readdir(dir)) {
      if (!f.endsWith('.json')) continue
      count += 1
      try {
        sizeSum += (await stat(join(dir, f))).size
      } catch {
        /* file vanished mid-scan */
      }
    }
    return { mtimeMs, count, sizeSum }
  } catch {
    return { mtimeMs: -1, count: 0, sizeSum: 0 }
  }
}

export function stampsEqual(a: DirStamp, b: DirStamp): boolean {
  return a.mtimeMs === b.mtimeMs && a.count === b.count && a.sizeSum === b.sizeSum
}

/** Drop one entity-directory cache entry (pass the absolute `…/entities/{kind}` path). */
export function invalidateMatchKeyDir(dir: string): void {
  matchKeyCache.delete(dir)
}

/** Drop the entire match-key cache (tests / full brain purge). */
export function resetMatchKeyCacheForTests(): void {
  matchKeyCache.clear()
}
