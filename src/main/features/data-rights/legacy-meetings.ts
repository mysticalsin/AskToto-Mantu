import type { Dirent } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

export interface LegacyMeetingsDeps {
  /** The pre-rename "AskToto Meetings" folder, a sibling of the resolved meetings folder. */
  folder: string
  /** True for a Métis-written meeting; anything else (a person's own note) is not ours to delete. */
  isOwned(folder: string, file: string): Promise<boolean | string | symbol>
}

/**
 * Erases the owner's meeting files from the legacy folder (G82). The copy-forward only ever copied them, so a leftover
 * original there would be copied again on a fresh install. Never touches README.md / index.md (the folder's own
 * bookkeeping), a file that is not Métis content, or a symlink. An ownership check that cannot read a file counts as
 * failed and leaves it. Only counts leave this function: no file name, no error text.
 */
export async function eraseLegacyOwnedMeetings(deps: LegacyMeetingsDeps): Promise<{ deleted: number; failed: number }> {
  let entries: Dirent[]
  try {
    entries = await readdir(deps.folder, { withFileTypes: true })
  } catch {
    return { deleted: 0, failed: 0 } // no legacy folder
  }
  let deleted = 0
  let failed = 0
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === 'README.md' || entry.name === 'index.md')
      continue
    try {
      const owned = await deps.isOwned(deps.folder, entry.name)
      if (owned === false) continue
      if (owned !== true) {
        failed += 1
        continue
      }
      await rm(join(deps.folder, entry.name), { force: true })
      deleted += 1
    } catch {
      failed += 1
    }
  }
  return { deleted, failed }
}
