/**
 * Launch sweep for orphaned atomic-write temp files in the meetings root.
 *
 * `atomicSavedWrite` and `atomicSavedWriteStream` write `<name>.md.<hex>.tmp` beside the destination and
 * rename it into place. A kill (SIGKILL, power loss) between the write and the rename leaves that temp
 * behind, and with encryption off it is a stray copy of the transcript. Recovery rebuilds the meeting
 * from its draft or journal, so the temp is never needed again.
 *
 * Only names that match the writers' exact pattern (12 or 24 lowercase hex digits after a `.md` name) are
 * considered, and only regular, non-symlink files older than a safety age: a temp younger than that may
 * belong to a live writer. The sweep reads the directory listing and each entry's metadata, never file
 * contents, so a cloud-only placeholder (OneDrive, iCloud) is not hydrated. It does not recurse.
 */
import { lstat, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { auditLog } from '../../logger'

/** 12 hex digits come from atomicSavedWrite, 24 from atomicSavedWriteStream. */
const ORPHAN_TEMP_NAME = /^.+\.md\.(?:[0-9a-f]{12}|[0-9a-f]{24})\.tmp$/

/** A temp younger than this may still belong to a live writer, so it is never removed. */
export const ORPHAN_TEMP_MIN_AGE_MS = 2 * 60_000

export interface OrphanTempSweepResult {
  /** Temp files removed. */
  swept: number
  /** Matching temps left in place: too young, not a regular file, a symlink, or already gone. */
  skipped: number
  /** Matching old temps that could not be removed (for example EPERM from a sync client). */
  failed: number
}

/** The only fs calls the sweep makes. None of them reads file contents. */
export interface OrphanTempFs {
  readdir(path: string): Promise<string[]>
  lstat(path: string): Promise<{ isFile(): boolean; isSymbolicLink(): boolean; mtimeMs: number }>
  unlink(path: string): Promise<void>
}

const REAL_FS: OrphanTempFs = { readdir: (path) => readdir(path), lstat: (path) => lstat(path), unlink }

/** Removes stale atomic-write temps directly inside `folder`. Never rejects; audits counts only. */
export async function sweepOrphanSavedTemps(
  folder: string,
  options: { now?: number; minAgeMs?: number; fs?: OrphanTempFs } = {}
): Promise<OrphanTempSweepResult> {
  const { now = Date.now(), minAgeMs = ORPHAN_TEMP_MIN_AGE_MS, fs = REAL_FS } = options
  const result: OrphanTempSweepResult = { swept: 0, skipped: 0, failed: 0 }
  let names: string[]
  try {
    names = await fs.readdir(folder)
  } catch {
    return result
  }
  for (const name of names) {
    if (!ORPHAN_TEMP_NAME.test(name)) continue
    const path = join(folder, name)
    try {
      const stats = await fs.lstat(path)
      if (!stats.isFile() || stats.isSymbolicLink() || now - stats.mtimeMs < minAgeMs) {
        result.skipped++
        continue
      }
      await fs.unlink(path)
      result.swept++
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') result.skipped++
      else result.failed++
    }
  }
  if (result.swept + result.skipped + result.failed > 0) auditLog('transcript.temp_swept', { ...result })
  return result
}
