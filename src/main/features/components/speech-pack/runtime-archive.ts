import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open } from 'node:fs/promises'

const MAX_ARCHIVE_BYTES = 10_000_000_000

function regularSingleLink(stat: BigIntStats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n
}

function version(stat: BigIntStats): string {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.nlink,
    stat.uid,
    stat.gid,
    stat.rdev,
    stat.size,
    stat.blksize,
    stat.blocks,
    stat.mtimeNs,
    stat.ctimeNs,
    stat.birthtimeNs
  ]
    .map(String)
    .join(':')
}

export async function hashPinnedArchive(path: string, expectedBytes: number): Promise<string> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > MAX_ARCHIVE_BYTES) {
    throw new Error('RUNTIME_ARCHIVE_SIZE_INVALID')
  }
  const noFollow = constants.O_NOFOLLOW ?? 0
  const nonBlock = constants.O_NONBLOCK ?? 0
  if (process.platform !== 'win32' && (!noFollow || !nonBlock)) {
    throw new Error('RUNTIME_ARCHIVE_SAFE_OPEN_UNAVAILABLE')
  }
  const handle = await open(path, constants.O_RDONLY | noFollow | nonBlock)
  try {
    const opened = await handle.stat({ bigint: true })
    if (!regularSingleLink(opened) || opened.size !== BigInt(expectedBytes)) {
      throw new Error('RUNTIME_ARCHIVE_SHAPE_MISMATCH')
    }
    const pathBefore = await lstat(path, { bigint: true })
    if (!regularSingleLink(pathBefore) || version(pathBefore) !== version(opened)) {
      throw new Error('RUNTIME_ARCHIVE_SHAPE_MISMATCH')
    }
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let offset = 0
    while (offset < expectedBytes) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, expectedBytes - offset), offset)
      if (bytesRead === 0) throw new Error('RUNTIME_ARCHIVE_TRUNCATED')
      hash.update(buffer.subarray(0, bytesRead))
      offset += bytesRead
    }
    const extra = Buffer.allocUnsafe(1)
    const { bytesRead: extraBytes } = await handle.read(extra, 0, 1, expectedBytes)
    if (extraBytes !== 0) throw new Error('RUNTIME_ARCHIVE_TOO_LARGE')
    const after = await handle.stat({ bigint: true })
    const pathAfter = await lstat(path, { bigint: true })
    if (version(after) !== version(opened) || !regularSingleLink(pathAfter) || version(pathAfter) !== version(opened)) {
      throw new Error('RUNTIME_ARCHIVE_CHANGED_DURING_VERIFY')
    }
    return hash.digest('hex')
  } finally {
    await handle.close().catch(() => undefined)
  }
}
