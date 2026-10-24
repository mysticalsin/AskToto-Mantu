/**
 * snapshot-order.ts — keeps a bridge's pushed and pulled snapshots in order (G30).
 *
 * The pill subscribes to `onState` and then asks `getState`. Either can arrive last, so a slow `getState` reply must
 * never overwrite a newer push: that would hide the indicator and its Stop while capture is still running. A snapshot
 * with a numeric `revision` is accepted only when it is not older than the newest one seen. One without a revision
 * cannot be ordered, so after any push a pulled value is treated as older and dropped.
 */

export interface SnapshotOrder {
  /** A value from `onState`. True when it should replace what is on screen. */
  push(next: unknown): boolean
  /** A value from `getState`. True when it should replace what is on screen. */
  pull(next: unknown): boolean
}

function revisionOf(value: unknown): number | null {
  const revision = (value as { revision?: unknown } | null)?.revision
  return typeof revision === 'number' && Number.isFinite(revision) ? revision : null
}

export function createSnapshotOrder(): SnapshotOrder {
  let newest: number | null = null
  let pushed = false
  const admit = (next: unknown, fromPush: boolean): boolean => {
    if (next === null || next === undefined) return false
    const revision = revisionOf(next)
    if (revision === null) {
      if (!fromPush && pushed) return false
    } else if (newest !== null && revision < newest) {
      return false
    }
    if (revision !== null) newest = revision
    if (fromPush) pushed = true
    return true
  }
  return { push: (next) => admit(next, true), pull: (next) => admit(next, false) }
}
