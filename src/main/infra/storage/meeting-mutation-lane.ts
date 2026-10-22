/**
 * Per-file mutation lock for saved-meeting read-modify-write.
 *
 * Every writer that reads a saved meeting, edits it in memory and writes it back (rename, recap, transcript lines,
 * CRM marker, confidential flag, debrief, delete) runs inside `withMeetingMutation(path, ...)`, so two of them can
 * never interleave on one file and silently drop each other's edit. The lock is a promise chain per resolved path.
 *
 * Deliberately separate from path-lane.ts: that lane is held by the atomic writer around its rename, so a mutation
 * that used it would deadlock on its own write. Not reentrant: a holder must never call another `withMeetingMutation`
 * for the same path (it would wait on itself), so wrapped writers do not call each other.
 */
import { resolve } from 'node:path'

const tails = new Map<string, Promise<void>>()

function mutationKey(path: string): string {
  const key = resolve(path)
  return process.platform === 'win32' || process.platform === 'darwin' ? key.toLowerCase() : key
}

/** Run `fn` once every earlier mutation of this file has settled. The lock is released when `fn` throws. */
export async function withMeetingMutation<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const key = mutationKey(path)
  const previous = tails.get(key) ?? Promise.resolve()
  let release!: () => void
  const mine = new Promise<void>((done) => {
    release = done
  })
  // `previous` is built only from `mine` promises, which only ever resolve, so this chain cannot reject.
  const tail = previous.then(() => mine)
  tails.set(key, tail)
  await previous
  try {
    return await fn()
  } finally {
    release()
    if (tails.get(key) === tail) tails.delete(key)
  }
}

/** Number of files with a holder or waiter; tests use it to prove the lock is released. */
export function activeMeetingMutationCountForTests(): number {
  return tails.size
}
