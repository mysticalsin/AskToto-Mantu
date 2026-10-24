import { editMeetingIndex, removeMeetingFile } from '../meeting-files'
import { removeMeetingRecordEdits } from '../features/meeting-record'
import { defaultRecordEditsDeps } from '../features/meeting-record/default-deps'
import { deleteMemoryForLocalMeeting } from './meeting-deletion'

/** Keep local deletion authoritative, then propagate a path-free source tombstone when the server is configured. */
export async function deleteMeetingWithMemoryPropagation(
  folder: string,
  safeName: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    await removeMeetingFile(folder, safeName)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ok: false, error: 'Meeting file not found.' }
    return { ok: false, error: 'Could not delete meeting file.' }
  }

  await propagateMeetingMemoryDeletion(safeName)
  await removeMeetingRecordEdits(defaultRecordEditsDeps, folder, safeName)
  try {
    const escaped = safeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    await editMeetingIndex(folder, (raw) =>
      raw
        .split('\n')
        .filter((line) => !new RegExp(`\\(${escaped}\\)`).test(line))
        .join('\n')
    )
  } catch {
    /* index update is best-effort; never fail the delete because of it */
  }
  return { ok: true }
}

/** Called after local file removal succeeds; the scoped adapter hashes the basename before sending it. */
export async function propagateMeetingMemoryDeletion(file: string): Promise<void> {
  await deleteMemoryForLocalMeeting(file)
}
