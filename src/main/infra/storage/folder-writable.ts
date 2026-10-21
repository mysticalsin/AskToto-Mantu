/**
 * folder-writable.ts — proves a chosen folder accepts a new file before Métis saves meetings there.
 *
 * Permission bits alone do not answer this (a synced or network folder, a read-only volume, a sandbox denial), so
 * the probe creates and removes one uniquely named empty file. Async only; nothing else in the folder is touched.
 */
import { randomBytes } from 'node:crypto'
import { unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function probeFolderWritable(dir: string): Promise<boolean> {
  const probe = join(dir, `.metis-write-check-${randomBytes(6).toString('hex')}`)
  try {
    await writeFile(probe, '', { flag: 'wx' })
  } catch {
    return false
  }
  await unlink(probe).catch(() => {
    /* created but not removable: still writable; the hidden empty file is harmless */
  })
  return true
}
