import { cp, lstat, mkdir, readdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

function isInside(root, path, allowRoot = false) {
  const rel = relative(root, path)
  return (allowRoot && rel === '') || (rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

async function copyEntry(source, destination, boundary, activeDirectories) {
  let stat
  try {
    stat = await lstat(source)
  } catch (error) {
    throw new Error(`Unable to read staged source ${source}: ${error.code ?? error.message}`)
  }

  if (stat.isSymbolicLink()) {
    if (!boundary) throw new Error(`Staged source contains a symbolic link outside an approved tree: ${source}`)
    let resolvedTarget
    try {
      resolvedTarget = await realpath(source)
    } catch (error) {
      throw new Error(
        `Staged source contains a dangling or invalid symbolic link ${source}: ${error.code ?? error.message}`
      )
    }
    if (resolvedTarget === boundary || !isInside(boundary, resolvedTarget)) {
      throw new Error(`Staged source symbolic link escapes its approved tree: ${source}`)
    }
    await copyEntry(resolvedTarget, destination, boundary, activeDirectories)
    return
  }

  const realSource = await realpath(source)
  if (boundary && !isInside(boundary, realSource, true)) {
    throw new Error(`Staged source escapes its approved tree: ${source}`)
  }
  if (stat.isDirectory()) {
    if (activeDirectories.has(realSource)) throw new Error(`Staged source contains a directory link cycle: ${source}`)
    activeDirectories.add(realSource)
    await mkdir(destination, { recursive: true })
    for (const name of await readdir(source)) {
      await copyEntry(join(source, name), join(destination, name), boundary, activeDirectories)
    }
    activeDirectories.delete(realSource)
    return
  }
  if (!stat.isFile()) throw new Error(`Staged source is not a regular file: ${source}`)
  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination, { errorOnExist: true, force: false, preserveTimestamps: true })
}

/**
 * Copy a staged resource tree. Symlinks are refused by default; an approved target tree may opt in to
 * materializing only symlinks whose fully resolved target remains strictly inside that tree.
 * @param {string} sourceArgument
 * @param {string} destination
 * @param {{ allowSymlinkTargetsWithin?: string | null }} [options]
 */
export async function copyContainedTree(sourceArgument, destination, { allowSymlinkTargetsWithin = null } = {}) {
  const source = resolve(sourceArgument)
  const rootStat = await lstat(source)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Staged source root must be a real directory: ${source}`)
  }
  const boundary = allowSymlinkTargetsWithin ? await realpath(resolve(allowSymlinkTargetsWithin)) : null
  const activeDirectories = new Set()
  await copyEntry(source, resolve(destination), boundary, activeDirectories)
}
