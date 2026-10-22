import type { Settings } from '@shared/ipc'
import { brainDir, brainWriteGeneration } from './store'

/**
 * D8-5: readAliasMap raw-reads every entity file plus the journal. The brain IPC handlers call it on every
 * deal outcome / commitment click, and ingest calls it per meeting. The result only changes when the brain is
 * written, so it is kept until the next write. `brainWriteGeneration` moves on every store write and purge;
 * the short time limit covers a sibling device syncing entity files in behind this process.
 * Callers get a copy: the map is a plain Map and some callers add to it.
 */
const MAX_AGE_MS = 5_000
let cached: { key: string; at: number; map: ReadonlyMap<string, unknown> } | null = null

export function cachedAliasMap<V>(s: Settings, build: () => Map<string, V>): Map<string, V> {
  const key = `${brainDir(s)}|${brainWriteGeneration()}`
  const now = Date.now()
  if (!cached || cached.key !== key || now - cached.at > MAX_AGE_MS) {
    cached = { key, at: now, map: build() }
  }
  return new Map(cached.map as ReadonlyMap<string, V>)
}
