/**
 * Asynchronous stable-identity read of a single regular file under a configured root.
 *
 * This is a dispatch-time proof: the bytes it returns must belong to the exact file identity it checked. The
 * proof has no synchronous fs calls, so coherence comes from two things instead of an uninterrupted tick:
 *  1. ONE descriptor per read. After the path identity checks the file is opened, the descriptor's identity is
 *     compared with the path identity, the bytes are read from that same descriptor, and the descriptor and
 *     path identities are compared again afterwards. The descriptor pins the inode, so an external writer or
 *     replacement can only make the read refuse, never mix identities.
 *  2. A per-path lane (path-lane.ts) shared with the atomic saved writers, so no in-process write can land
 *     between the identity checks and the last byte read.
 * The primitives never throw; every failure is `refused` / null.
 */
import { constants, realpath as realpathCallback } from 'node:fs'
import { lstat, open, realpath, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { withPathLane } from './path-lane'

export type StableRead = { status: 'ok'; bytes: Buffer; canonicalRoot: string } | { status: 'refused' }

const realpathNative = promisify(realpathCallback.native)

/**
 * Canonical (symlink-resolved) path, or null when it cannot be resolved. Uses the native realpath
 * (uv_fs_realpath) so it matches canonicalSourceRootId on Windows (8.3 names, casing).
 */
export async function canonicalPath(path: string): Promise<string | null> {
  try {
    return await realpathNative(path)
  } catch {
    return null
  }
}

function sameFileVersion(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
}

function isCanonicalDescendant(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** Fill `bytes` from the descriptor; false when the file ends early or the descriptor misbehaves. */
async function readFully(handle: FileHandle, bytes: Buffer): Promise<boolean> {
  let offset = 0
  while (offset < bytes.length) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
    if (bytesRead <= 0) return false
    offset += bytesRead
  }
  return true
}

/**
 * Read `name` under `root` through a bounded file descriptor, refusing unless the path, descriptor and
 * canonical locations keep one identity from before the open until after the last byte is read.
 */
export async function readStableRegularFile(root: string, name: string, maxBytes: number): Promise<StableRead> {
  const file = join(root, name)
  return withPathLane(file, async (): Promise<StableRead> => {
    let handle: FileHandle | undefined
    try {
      const canonicalRoot = await realpathNative(root)
      const canonicalFile = await realpathNative(file)
      const relativePath = relative(canonicalRoot, canonicalFile)
      if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath))
        return { status: 'refused' }
      const pathBefore = await lstat(file)
      if (pathBefore.isSymbolicLink() || !pathBefore.isFile() || pathBefore.size < 1 || pathBefore.size > maxBytes)
        return { status: 'refused' }
      // The path may be swapped after lstat. Nonblocking open prevents a regular-file-to-FIFO race from
      // hanging Main; NOFOLLOW rejects a symlink replacement at the open boundary where supported.
      handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0))
      const before = await handle.stat()
      if (!before.isFile() || !sameFileVersion(before, pathBefore)) return { status: 'refused' }
      const bytes = Buffer.allocUnsafe(before.size)
      if (!(await readFully(handle, bytes))) return { status: 'refused' }
      const after = await handle.stat()
      const pathAfter = await lstat(file)
      if (
        pathAfter.isSymbolicLink() ||
        !pathAfter.isFile() ||
        !sameFileVersion(after, before) ||
        !sameFileVersion(pathAfter, after) ||
        (await realpathNative(root)) !== canonicalRoot ||
        (await realpathNative(file)) !== canonicalFile
      )
        return { status: 'refused' }
      // Relinquish ownership before close: an error must refuse the read without retrying a reused handle.
      const completed = handle
      handle = undefined
      await completed.close()
      return { status: 'ok', bytes, canonicalRoot }
    } catch {
      return { status: 'refused' }
    } finally {
      if (handle) {
        try {
          await handle.close()
        } catch {
          /* The read is already refused; do not retry an uncertain descriptor. */
        }
      }
    }
  })
}

/** Read a bounded, stable byte snapshot without consulting or populating the stat-keyed JSON cache. */
export async function readStableSnapshotBytes(rootPath: string, path: string, maxBytes: number): Promise<Buffer | null> {
  return withPathLane(path, async (): Promise<Buffer | null> => {
    let handle: FileHandle | undefined
    try {
      const canonicalRoot = await realpath(rootPath)
      const canonicalPathBefore = await realpath(path)
      if (!isCanonicalDescendant(canonicalRoot, canonicalPathBefore)) return null
      const pathBefore = await lstat(path)
      if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) return null
      handle = await open(path, 'r')
      const before = await handle.stat()
      if (!before.isFile() || !sameFileVersion(pathBefore, before) || before.size <= 0 || before.size > maxBytes)
        return null
      const canonicalRootAfterOpen = await realpath(rootPath)
      const canonicalPathAfterOpen = await realpath(path)
      if (
        canonicalRootAfterOpen !== canonicalRoot ||
        !isCanonicalDescendant(canonicalRoot, canonicalPathAfterOpen) ||
        !sameFileVersion(before, await stat(canonicalPathAfterOpen))
      )
        return null
      const bytes = Buffer.allocUnsafe(before.size)
      if (!(await readFully(handle, bytes))) return null
      const after = await handle.stat()
      const pathAfter = await lstat(path)
      const canonicalRootAfterRead = await realpath(rootPath)
      const canonicalPathAfterRead = await realpath(path)
      if (
        pathAfter.isSymbolicLink() ||
        !pathAfter.isFile() ||
        canonicalRootAfterRead !== canonicalRoot ||
        !isCanonicalDescendant(canonicalRoot, canonicalPathAfterRead) ||
        !sameFileVersion(before, after) ||
        !sameFileVersion(after, pathAfter) ||
        !sameFileVersion(after, await stat(canonicalPathAfterRead))
      )
        return null
      // Relinquish ownership before close: an error must refuse the read without retrying a reused handle.
      const completed = handle
      handle = undefined
      await completed.close()
      return bytes
    } catch {
      return null
    } finally {
      if (handle) {
        try {
          await handle.close()
        } catch {
          /* The snapshot is already refused; do not retry an uncertain descriptor. */
        }
      }
    }
  })
}
