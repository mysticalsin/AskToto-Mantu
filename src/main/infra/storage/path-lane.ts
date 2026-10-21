/**
 * Per-path async mutex ("lane").
 *
 * The stable readers (stable-read.ts) and the atomic saved writers (atomic-saved-write.ts) share one lane per
 * file path, so an in-process rename can never land between a reader's identity checks and its byte read.
 * A reader holds the lane for its whole identity-check, open, read, re-check sequence; a writer holds it only
 * around the single `rename` that makes new bytes visible. Writes stay atomic (temp file + rename) and the
 * temp file is built outside the lane, so a writer never waits for a reader while it prepares its bytes.
 *
 * This only orders work inside this process. External writers are handled by the readers' descriptor pinning
 * and their before/after identity comparison, which refuses on any difference.
 */
import { resolve } from 'node:path'

const tails = new Map<string, Promise<void>>()

function laneKey(path: string): string {
  const key = resolve(path)
  return process.platform === 'win32' || process.platform === 'darwin' ? key.toLowerCase() : key
}

/** Run `fn` once every earlier holder of this path's lane has finished. Lanes are released on throw. */
export async function withPathLane<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const key = laneKey(path)
  const previous = tails.get(key) ?? Promise.resolve()
  let release!: () => void
  const mine = new Promise<void>((done) => {
    release = done
  })
  // `previous` only ever resolves (it is built from `mine` promises), so this chain cannot reject.
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

/** Number of paths with a holder or waiter; tests use it to prove lanes are released. */
export function activePathLaneCountForTests(): number {
  return tails.size
}
