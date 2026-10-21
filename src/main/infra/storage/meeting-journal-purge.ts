import { lstat, readdir, realpath, rmdir, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * Removal of the live meeting journal's on-disk state, `<userData>/meeting-journal/<uuid>/`. This is the only delete the
 * journal has. It is deliberately narrow: it removes one meeting directory whose name is a journal UUID, never follows
 * a symbolic link, and refuses any path that does not resolve to a real directory directly under the real
 * `<userData>/meeting-journal` directory. A planted link (to the meetings folder, to userData, anywhere) is refused,
 * never traversed and never deleted through.
 */

export const MEETING_JOURNAL_DIRECTORY = 'meeting-journal'
/** Same shape the journal format accepts for a meeting id (versions 1-8). */
export const MEETING_JOURNAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** A journal holds 3 files per record and at most ~12,000 records; this bounds one purge, not a legal journal. */
const MAX_ENTRIES = 200_000
const MAX_DEPTH = 4

export type MeetingJournalPurgeResult =
  | { status: 'purged'; removedFiles: number }
  | { status: 'absent' }
  | { status: 'refused'; reason: 'invalid-id' | 'unsafe-path' }
  | { status: 'failed' }

/** The journals root under a main-owned userData directory (not created, not resolved). */
export function meetingJournalRoot(userDataPath: string): string {
  return join(userDataPath, MEETING_JOURNAL_DIRECTORY)
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code
}

/**
 * Resolves `<userData>/meeting-journal` to its real directory, or `'absent'`, or `'unsafe'` when it is not a plain
 * directory directly under the real userData (a link, a file, or a path that resolves elsewhere).
 */
export async function resolveMeetingJournalRoot(userDataPath: string): Promise<string | 'absent' | 'unsafe'> {
  const root = meetingJournalRoot(resolve(userDataPath))
  try {
    const entry = await lstat(root)
    if (!entry.isDirectory() || entry.isSymbolicLink()) return 'unsafe'
    const real = await realpath(root)
    const expected = join(await realpath(resolve(userDataPath)), MEETING_JOURNAL_DIRECTORY)
    return real === expected ? real : 'unsafe'
  } catch (error) {
    return code(error) === 'ENOENT' ? 'absent' : 'unsafe'
  }
}

async function removeTree(directory: string, depth: number, budget: { entries: number }): Promise<number> {
  if (depth > MAX_DEPTH) throw new Error('journal tree is too deep')
  let removed = 0
  for (const name of await readdir(directory)) {
    if (++budget.entries > MAX_ENTRIES) throw new Error('journal tree is too large')
    const path = join(directory, name)
    const entry = await lstat(path)
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      removed += await removeTree(path, depth + 1, budget)
      await rmdir(path)
    } else {
      // A regular file, or a link: the link itself is removed, its target is never opened.
      await unlink(path)
      removed++
    }
  }
  return removed
}

/** Removes one meeting's journal directory (records, manifest and wrapped key). Never throws. */
export async function purgeMeetingJournalDirectory(
  userDataPath: string,
  meetingId: string
): Promise<MeetingJournalPurgeResult> {
  if (!MEETING_JOURNAL_ID.test(meetingId)) return { status: 'refused', reason: 'invalid-id' }
  try {
    const root = await resolveMeetingJournalRoot(userDataPath)
    if (root === 'absent') return { status: 'absent' }
    if (root === 'unsafe') return { status: 'refused', reason: 'unsafe-path' }
    const directory = join(root, meetingId.toLowerCase())
    let entry
    try {
      entry = await lstat(directory)
    } catch (error) {
      return code(error) === 'ENOENT' ? { status: 'absent' } : { status: 'failed' }
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) return { status: 'refused', reason: 'unsafe-path' }
    // The directory must still be the real child of the real root (no swap between the check and the walk).
    if ((await realpath(directory)) !== join(root, meetingId.toLowerCase())) {
      return { status: 'refused', reason: 'unsafe-path' }
    }
    const removedFiles = await removeTree(directory, 0, { entries: 0 })
    await rmdir(directory)
    return { status: 'purged', removedFiles }
  } catch {
    return { status: 'failed' }
  }
}
