import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { realInside, treeBytes } from './fs-evict'

export type SpeechPackEvictResult =
  | { ok: true; bytesFreed: number }
  | { ok: false; reason: 'busy' | 'absent' | 'failed' }

/**
 * Delete one speech pack's installed directory and its staging (G87). The activation directory is renamed to
 * `.staging/<id>/evict-<uuid>` first (atomic, same volume), so the resolver reports `not-installed` at once and a
 * crash mid-delete leaves only an `evict-*` entry that the startup sweep removes. The path is built from the
 * engine's own root and a closed component id; a link or a directory outside the root is refused, never followed.
 */
export async function evictGuarded(options: {
  rootDir: string
  id: string
  known: boolean
  /** True while the component is queued or running; eviction then refuses. */
  running: boolean
  /** Ids being evicted right now; also blocks a second eviction (and, in the engine, a new install). */
  inProgress: Set<string>
  onEvicted: () => void
}): Promise<SpeechPackEvictResult> {
  if (!options.known) return { ok: false, reason: 'failed' }
  if (options.running || options.inProgress.has(options.id)) return { ok: false, reason: 'busy' }
  options.inProgress.add(options.id)
  try {
    const result = await evictPackDirectory(options.rootDir, options.id)
    if (result.ok) options.onEvicted()
    return result
  } finally {
    options.inProgress.delete(options.id)
  }
}

async function evictPackDirectory(rootDir: string, componentId: string): Promise<SpeechPackEvictResult> {
  const final = join(rootDir, componentId)
  let info
  try {
    info = await lstat(final)
  } catch (error) {
    return { ok: false, reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'failed' }
  }
  try {
    if (!info.isDirectory() || info.isSymbolicLink() || !(await realInside(rootDir, final)))
      return { ok: false, reason: 'failed' }
    if ((await readdir(final)).length === 0) return { ok: false, reason: 'absent' }
    const stagingParent = join(rootDir, '.staging', componentId)
    await mkdir(stagingParent, { recursive: true })
    await rename(final, join(stagingParent, `evict-${randomUUID()}`))
    // Measured after the rename and before the delete: the pack, its marker and any staged partials.
    const bytesFreed = await treeBytes(stagingParent)
    await rm(stagingParent, { recursive: true, force: true })
    return { ok: true, bytesFreed }
  } catch {
    return { ok: false, reason: 'failed' }
  }
}
