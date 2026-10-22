import { slugify } from './entity-values'
import type { CorrectionEntry } from '@shared/brain'

export const UNMERGE_BLOCKED_ERROR = "This merge can't be undone because one of these records changed after it."

type MergeEntry = Extract<CorrectionEntry, { kind: 'entity_merge' }>

/**
 * D8-8: Undo restores point-in-time snapshots of both merged records, so it would silently discard anything
 * that happened to either one afterwards, and an old Undo could bring a record back that a later merge had
 * already absorbed. True when a journal entry after `merge` touches the merged-away or surviving record: a
 * rename or field pin on it, or another merge involving it that was not itself undone. Pure, live path only
 * (replay applies the journal in order and never needs it).
 */
export function laterEditTouchesMerge(entries: readonly CorrectionEntry[], merge: MergeEntry): boolean {
  const { kind, fromId, intoId } = merge.payload
  const ids = new Set([slugify(fromId), slugify(intoId)])
  const touches = (entryKind: string, id: string): boolean => entryKind === kind && ids.has(slugify(id))
  const undone = new Set<number>()
  for (const e of entries) if (e.kind === 'entity_unmerge') undone.add(e.payload.targetSeq)
  return entries.some((e) => {
    if (e.seq <= merge.seq) return false
    if (e.kind === 'entity_rename' || e.kind === 'field_update') return touches(e.payload.kind, e.payload.id)
    if (e.kind === 'entity_merge') {
      return (
        !undone.has(e.seq) && (touches(e.payload.kind, e.payload.fromId) || touches(e.payload.kind, e.payload.intoId))
      )
    }
    return false
  })
}
