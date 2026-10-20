/**
 * Synchronous stable-identity read of a single regular file under a configured root.
 *
 * Sync is deliberate here: this is a dispatch-time proof that must observe one coherent state with no await
 * gap between the identity checks and the bytes read. The primitives never throw; every failure is `refused`.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'

export type StableReadSync = { status: 'ok'; bytes: Buffer; canonicalRoot: string } | { status: 'refused' }

/** Canonical (symlink-resolved) path, or null when it cannot be resolved. */
export function canonicalPathSync(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/**
 * Read `name` under `root` through a bounded raw file descriptor, refusing unless the path, descriptor and
 * canonical locations keep one identity from before the open until after the last byte is read.
 */
export function readStableRegularFileSync(root: string, name: string, maxBytes: number): StableReadSync {
  const file = join(root, name)
  let fd: number | undefined
  try {
    const canonicalRoot = realpathSync(root)
    const canonicalFile = realpathSync(file)
    const relativePath = relative(canonicalRoot, canonicalFile)
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath))
      return { status: 'refused' }
    const pathBefore = lstatSync(file)
    if (pathBefore.isSymbolicLink() || !pathBefore.isFile() || pathBefore.size < 1 || pathBefore.size > maxBytes)
      return { status: 'refused' }
    // The path may be swapped after lstat. Nonblocking open prevents a regular-file-to-FIFO race from
    // hanging Main; NOFOLLOW rejects a symlink replacement at the open boundary where supported.
    fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0))
    const before = fstatSync(fd)
    if (
      !before.isFile() ||
      before.dev !== pathBefore.dev ||
      before.ino !== pathBefore.ino ||
      before.size !== pathBefore.size ||
      before.mtimeMs !== pathBefore.mtimeMs ||
      before.ctimeMs !== pathBefore.ctimeMs
    )
      return { status: 'refused' }
    const bytes = Buffer.allocUnsafe(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (count <= 0) return { status: 'refused' }
      offset += count
    }
    const after = fstatSync(fd)
    const pathAfter = lstatSync(file)
    if (
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      pathAfter.dev !== after.dev ||
      pathAfter.ino !== after.ino ||
      pathAfter.size !== after.size ||
      pathAfter.mtimeMs !== after.mtimeMs ||
      pathAfter.ctimeMs !== after.ctimeMs ||
      realpathSync(root) !== canonicalRoot ||
      realpathSync(file) !== canonicalFile
    )
      return { status: 'refused' }
    return { status: 'ok', bytes, canonicalRoot }
  } catch {
    return { status: 'refused' }
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* failed close cannot validate a source */
      }
    }
  }
}

function sameFileVersion(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
}

function isCanonicalDescendant(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** Read a bounded, stable byte snapshot without consulting or populating the stat-keyed JSON cache. */
export function readStableSnapshotBytesSync(rootPath: string, path: string, maxBytes: number): Buffer | null {
  let fd: number | undefined
  try {
    const canonicalRoot = realpathSync(rootPath)
    const canonicalPathBefore = realpathSync(path)
    if (!isCanonicalDescendant(canonicalRoot, canonicalPathBefore)) return null
    const pathBefore = lstatSync(path)
    if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) return null
    fd = openSync(path, 'r')
    const before = fstatSync(fd)
    if (!before.isFile() || !sameFileVersion(pathBefore, before) || before.size <= 0 || before.size > maxBytes)
      return null
    const canonicalRootAfterOpen = realpathSync(rootPath)
    const canonicalPathAfterOpen = realpathSync(path)
    if (
      canonicalRootAfterOpen !== canonicalRoot ||
      !isCanonicalDescendant(canonicalRoot, canonicalPathAfterOpen) ||
      !sameFileVersion(before, statSync(canonicalPathAfterOpen))
    )
      return null
    const bytes = Buffer.allocUnsafe(before.size)
    let offset = 0
    while (offset < before.size) {
      const count = readSync(fd, bytes, offset, before.size - offset, offset)
      if (count <= 0) return null
      offset += count
    }
    const after = fstatSync(fd)
    const pathAfter = lstatSync(path)
    const canonicalRootAfterRead = realpathSync(rootPath)
    const canonicalPathAfterRead = realpathSync(path)
    if (
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      canonicalRootAfterRead !== canonicalRoot ||
      !isCanonicalDescendant(canonicalRoot, canonicalPathAfterRead) ||
      !sameFileVersion(before, after) ||
      !sameFileVersion(after, pathAfter) ||
      !sameFileVersion(after, statSync(canonicalPathAfterRead))
    )
      return null
    return bytes
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* A close failure cannot make an incomplete snapshot usable. */
      }
    }
  }
}
