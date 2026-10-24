import { lstat, readdir, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

/**
 * Filesystem helpers shared by every offload target (G87). They never follow a symbolic link and never return a
 * path: callers learn byte counts and booleans only, so nothing here can put a username into a receipt or a log.
 */

/** Bytes a delete would free: the sum of lstat sizes over a tree. A symbolic link counts as itself, never its target. */
export async function treeBytes(path: string): Promise<number> {
  let info
  try {
    info = await lstat(path)
  } catch {
    return 0
  }
  if (!info.isDirectory()) return info.size
  let sum = 0
  for (const entry of await readdir(path)) sum += await treeBytes(join(path, entry))
  return sum
}

/** Delete the children of `dir` whose names start with `prefix`: leftovers of an offload that crashed mid-delete. */
export async function sweepAside(dir: string, prefix: string): Promise<void> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (name.startsWith(prefix)) await rm(join(dir, name), { recursive: true, force: true }).catch(() => undefined)
  }
}

/** True when `path` exists (a dangling link counts as existing). */
export async function pathPresent(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

/** True when the real location of `target` lies strictly inside the real location of `root`. */
export async function realInside(root: string, target: string): Promise<boolean> {
  try {
    const rel = relative(await realpath(root), await realpath(target))
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
  } catch {
    return false
  }
}
