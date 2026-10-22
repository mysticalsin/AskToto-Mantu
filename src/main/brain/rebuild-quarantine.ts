import { access, mkdir, readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { Settings } from '@shared/ipc'
import { resolveMeetingsFolder } from '../transcripts'

/**
 * Quarantined evidence a rebuild must not delete (Q04 / D8-3).
 *
 * When the correction journal, the index or the human marks file is found corrupt it is set aside inside
 * `.brain/` as `corrections.corrupt-*`, `index.corrupt-*` or `human-marks.corrupt-*`. A rebuild wipes the whole
 * `.brain/` root, so those copies were the only record of the earlier merges, renames, pins and marks. Move
 * them next to the preserved index copies in `.brain-preserved/` first. Moves, never copies, so no second copy
 * of the damaged data is left behind in the wiped root.
 *
 * Async, and run by startRebuild before purgeBrain. A failure rejects, so the rebuild aborts with the
 * evidence still in place instead of deleting it.
 */
const QUARANTINED = /^(corrections|index|human-marks)\.corrupt-/

export async function preserveQuarantinedBeforeRebuild(s: Settings): Promise<{ moved: number }> {
  const meetings = resolveMeetingsFolder(s)
  const root = join(meetings, '.brain')
  let names: string[]
  try {
    names = await readdir(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { moved: 0 }
    throw error
  }
  const targets = names.filter((name) => QUARANTINED.test(name))
  if (targets.length === 0) return { moved: 0 }
  const dir = join(meetings, '.brain-preserved')
  await mkdir(dir, { recursive: true })
  for (const name of targets) {
    let dest = join(dir, name)
    // Never overwrite an earlier preserved copy of the same name.
    for (
      let n = 1;
      await access(dest).then(
        () => true,
        () => false
      );
      n += 1
    )
      dest = join(dir, `${n}-${name}`)
    await rename(join(root, name), dest)
  }
  return { moved: targets.length }
}
