import { lstat, mkdir, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'

type RootIdentity = { path: string; dev: number; ino: number }

/** Resolves admitted root aliases to one physical directory and refuses replacement or final links. */
export function createIncrementalMeetingJournalRoot(
  rootInput: string,
  isCurrent: () => boolean,
  createIfMissing = true
) {
  const requestedRoot = resolve(rootInput)
  let identity: RootIdentity | undefined

  return async function resolveCurrentRoot(): Promise<string | undefined> {
    try {
      if (!isCurrent()) return undefined
      if (!identity) {
        if (createIfMissing) {
          await mkdir(requestedRoot, { recursive: true, mode: 0o700 })
          if (!isCurrent()) return undefined
        }
      }
      const requestedBefore = await lstat(requestedRoot)
      if (!isCurrent()) return undefined
      const path = resolve(await realpath(requestedRoot))
      if (!isCurrent()) return undefined
      const canonicalEntry = await lstat(path)
      if (!isCurrent()) return undefined
      const requestedAfter = await lstat(requestedRoot)
      if (
        !isCurrent() ||
        requestedBefore.isSymbolicLink() ||
        requestedAfter.isSymbolicLink() ||
        canonicalEntry.isSymbolicLink() ||
        !requestedBefore.isDirectory() ||
        !requestedAfter.isDirectory() ||
        !canonicalEntry.isDirectory() ||
        requestedBefore.dev !== requestedAfter.dev ||
        requestedBefore.ino !== requestedAfter.ino ||
        requestedAfter.dev !== canonicalEntry.dev ||
        requestedAfter.ino !== canonicalEntry.ino
      )
        return undefined
      // Directory link counts describe changing contents on some filesystems, not the root owner.
      // Retain its canonical path and physical identity; regular-file single-link guards stay separate.
      const next = { path, dev: canonicalEntry.dev, ino: canonicalEntry.ino }
      if (identity && (identity.path !== next.path || identity.dev !== next.dev || identity.ino !== next.ino))
        return undefined
      identity ??= next
      return path
    } catch {
      return undefined
    }
  }
}
