import { unlink } from 'node:fs/promises'

/**
 * Remove autosave draft files once a meeting ends normally (its real saveMeeting() already succeeded).
 *
 * The unlink gets the same bounded retry writeSaved() uses for rename: the default meetings folder is
 * OneDrive-synced, which routinely holds a just-written file open for upload hashing, and AV/EDR
 * real-time scanning grabs it too — unlink then throws EPERM/EBUSY on Windows even though nothing is
 * wrong. A single best-effort attempt leaves the draft on disk, and recoverOrphanDrafts() promotes it
 * on the next launch, so the user sees their meeting twice with the second copy labelled
 * "(recovered)". Retrying rides out the transient lock; a genuinely stuck file still degrades to the
 * old behaviour rather than failing the meeting end.
 */
export async function unlinkDraftFiles(
  files: readonly string[],
  isCurrent: () => boolean = () => true
): Promise<{ failed: string[]; pending: string[] }> {
  const failed: string[] = []
  for (let index = 0; index < files.length; index++) {
    const file = files[index]
    if (!isCurrent()) return { failed, pending: files.slice(index) }
    try {
      for (let attempt = 0; ; attempt++) {
        // Auth may change during an unlink retry delay; check immediately before every filesystem mutation.
        if (!isCurrent()) return { failed, pending: files.slice(index) }
        try {
          await unlink(file)
          break
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code
          if (code === 'ENOENT') break
          if ((code !== 'EPERM' && code !== 'EBUSY') || attempt >= 4) throw e
          await new Promise((r) => setTimeout(r, 40 * 2 ** attempt))
        }
      }
    } catch {
      failed.push(file)
    }
  }
  return { failed, pending: [] }
}
