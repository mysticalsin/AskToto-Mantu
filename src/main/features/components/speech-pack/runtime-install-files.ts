import { randomBytes } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, realpath } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { sameFileVersion } from './runtime-pointer-snapshot'
import {
  removeRuntimeFileAfterAdmission,
  renameRuntimeFileAfterAdmission
} from '../../../infra/storage/runtime-owned-files'

export const SAFE_FLAGS = constants.O_NOFOLLOW | constants.O_NONBLOCK

export async function fileVersion(path: string): Promise<BigIntStats | null> {
  try {
    const value = await lstat(path, { bigint: true })
    if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1n) {
      throw new Error('RUNTIME_INSTALL_POINTER_INVALID')
    }
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export type DirectoryIdentity = Pick<BigIntStats, 'dev' | 'ino' | 'birthtimeNs'>

export async function directoryIdentity(path: string): Promise<DirectoryIdentity> {
  const value = await lstat(path, { bigint: true })
  if (!value.isDirectory() || value.isSymbolicLink()) throw new Error('RUNTIME_INSTALL_DIRECTORY_INVALID')
  return { dev: value.dev, ino: value.ino, birthtimeNs: value.birthtimeNs }
}

export function sameDirectoryIdentity(expected: DirectoryIdentity, actual: BigIntStats): boolean {
  return (
    actual.isDirectory() &&
    !actual.isSymbolicLink() &&
    expected.dev === actual.dev &&
    expected.ino === actual.ino &&
    expected.birthtimeNs === actual.birthtimeNs
  )
}

export async function ensureOwnedDirectory(path: string): Promise<string> {
  try {
    await mkdir(path, { recursive: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const stat = await lstat(path)
  const canonical = await realpath(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || canonical !== resolve(path)) {
    throw new Error('RUNTIME_INSTALL_DIRECTORY_INVALID')
  }
  return canonical
}

export async function readPinnedFile(path: string, max: number): Promise<Buffer> {
  if (process.platform !== 'win32' && (!constants.O_NOFOLLOW || !constants.O_NONBLOCK)) {
    throw new Error('RUNTIME_SAFE_FILE_OPEN_UNAVAILABLE')
  }
  const handle = await open(path, constants.O_RDONLY | SAFE_FLAGS)
  try {
    const before = await handle.stat({ bigint: true })
    const named = await lstat(path, { bigint: true })
    const sameVersion = (a: BigIntStats, b: BigIntStats): boolean =>
      a.dev === b.dev &&
      a.ino === b.ino &&
      a.mode === b.mode &&
      a.nlink === b.nlink &&
      a.uid === b.uid &&
      a.gid === b.gid &&
      a.rdev === b.rdev &&
      a.size === b.size &&
      a.blocks === b.blocks &&
      a.mtimeNs === b.mtimeNs &&
      a.ctimeNs === b.ctimeNs &&
      a.birthtimeNs === b.birthtimeNs
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size < 1n ||
      before.size > BigInt(max) ||
      !named.isFile() ||
      named.nlink !== 1n ||
      !sameVersion(before, named)
    ) {
      throw new Error('RUNTIME_INSTALL_FILE_INVALID')
    }
    const chunks: Buffer[] = []
    let total = 0
    let position = 0
    while (total <= max) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, max + 1 - total))
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, position)
      if (bytesRead === 0) break
      chunks.push(chunk.subarray(0, bytesRead))
      total += bytesRead
      position += bytesRead
    }
    if (total > max) throw new Error('RUNTIME_INSTALL_FILE_TOO_LARGE')
    const bytes = Buffer.concat(chunks, total)
    const after = await handle.stat({ bigint: true })
    const namedAfter = await lstat(path, { bigint: true })
    if (BigInt(bytes.byteLength) !== before.size || !sameVersion(before, after) || !sameVersion(before, namedAfter)) {
      throw new Error('RUNTIME_INSTALL_FILE_CHANGED')
    }
    return bytes
  } finally {
    await handle.close().catch(() => undefined)
  }
}

export async function makeParents(root: string, relPath: string): Promise<string> {
  let current = root
  const pieces = relPath.split('/')
  for (const piece of pieces.slice(0, -1)) {
    current = join(current, piece)
    await ensureOwnedDirectory(current)
  }
  const rootPath = await realpath(root)
  const rel = relative(rootPath, resolve(current))
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(current) !== realpathSyncFree(rootPath, rel)) {
    throw new Error('RUNTIME_INSTALL_PATH_ESCAPE')
  }
  return join(current, pieces.at(-1) as string)
}

function realpathSyncFree(root: string, rel: string): string {
  return rel ? resolve(root, rel) : root
}

export async function writeExclusive(path: string, data: Uint8Array, mode: number): Promise<BigIntStats> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | SAFE_FLAGS, mode)
  try {
    await handle.writeFile(data)
    await handle.sync()
    const owned = await handle.stat({ bigint: true })
    const named = await lstat(path, { bigint: true })
    if (!owned.isFile() || owned.nlink !== 1n || !sameFileVersion(owned, named)) {
      throw new Error('RUNTIME_INSTALL_TEMP_OWNER_CHANGED')
    }
    return owned
  } finally {
    await handle.close()
  }
}

export async function writeBytesAtomic(
  path: string,
  bytes: Uint8Array,
  beforeRename: () => Promise<void | (() => void)> | void | (() => void),
  destinationVersion: BigIntStats | null,
  destinationBytes: Buffer | null
): Promise<void> {
  const temp = `${path}.${randomBytes(16).toString('hex')}.tmp`
  const tempVersion = await writeExclusive(temp, bytes, 0o600)
  try {
    await renameRuntimeFileAfterAdmission({
      source: temp,
      destination: path,
      sourceVersion: tempVersion,
      sourceBytes: Buffer.from(bytes),
      destinationVersion,
      destinationBytes,
      awaitAdmission: async () => beforeRename(),
      assertDestinationSync: () => undefined
    })
  } catch (error) {
    await removeRuntimeFileAfterAdmission(temp, tempVersion, Buffer.from(bytes))
    throw error
  }
}

export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function freezeTree(root: string, check: () => Promise<void>): Promise<void> {
  const visit = async (directory: string): Promise<void> => {
    for (const name of await readdir(directory)) {
      await check()
      const path = join(directory, name)
      const item = await lstat(path)
      if (item.isSymbolicLink()) throw new Error('RUNTIME_INSTALL_LINK_REJECTED')
      if (item.isDirectory()) {
        await visit(path)
        await chmod(path, 0o500)
        await check()
      } else if (item.isFile() && item.nlink === 1) {
        await chmod(path, (item.mode & 0o111) !== 0 ? 0o500 : 0o400)
        await check()
      } else throw new Error('RUNTIME_INSTALL_SPECIAL_FILE')
    }
  }
  await visit(root)
  await check()
  await chmod(root, 0o500)
  await check()
}
