import type { CorrectionEntry } from '@shared/brain'
import { isErasureFenced } from '../memory-partition/erasure-fence'

/**
 * G82 no-resurrection: a OneDrive conflict copy of the correction journal that synced back after the owner erased their
 * data still holds the corrections they made before. Each entry carries the time it was made, so an entry made before
 * the erasure is dropped and one made after it is kept. An entry with no readable time is kept (it cannot be shown to
 * predate the erasure).
 */
export function unerasedEntries(entries: CorrectionEntry[]): CorrectionEntry[] {
  return entries.filter((entry) => !isErasureFenced(Date.parse(entry.at)))
}
