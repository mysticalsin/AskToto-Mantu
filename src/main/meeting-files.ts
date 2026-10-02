/**
 * The meetings-folder writes the storage gateway has no surface for: removing a file, and rewriting
 * index.md. Kept here so recall.ts reaches the meetings folder only through the gateway and these helpers.
 *
 * Invariant: `name` is a basename the caller already checked (safeMeetingBasename, or a name from the
 * gateway's own listing); these helpers never build a path from anything else.
 */
import { unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { storageAt } from './infra/storage/meetings-storage'

/** Removes one file from the meetings folder. Rejects as unlink does (code ENOENT when it is missing). */
export function removeMeetingFile(folder: string, name: string): Promise<void> {
  return unlink(join(folder, name))
}

/** Rewrites index.md with `edit`'s result when that changes it. A missing or unreadable index is left
 *  alone; a failed write rejects. */
export async function editMeetingIndex(folder: string, edit: (raw: string) => string): Promise<void> {
  const read = await storageAt(folder).read('index.md')
  if (read.status !== 'ok') return
  const raw = read.bytes.toString('utf8')
  const edited = edit(raw)
  if (edited !== raw) await writeFile(join(folder, 'index.md'), edited, 'utf8')
}
