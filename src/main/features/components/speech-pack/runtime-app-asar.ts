import { lstat, open } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { app } from 'electron'

/** Read only fixed app-owned ASAR members; Electron fstat is physical while ASAR lstat is synthetic. */
export async function readBoundedAppAsarMember(path: string, maxBytes: number): Promise<Buffer> {
  const appRoot = resolve(app.getAppPath())
  const absolute = resolve(path)
  const rel = relative(appRoot, absolute)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || absolute !== path) {
    throw new Error('APP_ASAR_PATH_INVALID')
  }
  const namedBefore = await lstat(absolute)
  if (!namedBefore.isFile() || namedBefore.isSymbolicLink() || namedBefore.size < 1 || namedBefore.size > maxBytes) {
    throw new Error('APP_ASAR_MEMBER_INVALID')
  }
  const handle = await open(absolute, 'r')
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size !== BigInt(namedBefore.size) || before.size > BigInt(maxBytes)) {
      throw new Error('APP_ASAR_MEMBER_INVALID')
    }
    const chunks: Buffer[] = []
    let total = 0
    let position = 0
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total))
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, position)
      if (!bytesRead) break
      chunks.push(chunk.subarray(0, bytesRead))
      total += bytesRead
      position += bytesRead
    }
    const after = await handle.stat({ bigint: true })
    const namedAfter = await lstat(absolute)
    if (
      total > maxBytes ||
      BigInt(total) !== before.size ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      !namedAfter.isFile() ||
      namedAfter.isSymbolicLink() ||
      namedAfter.size !== Number(before.size)
    ) {
      throw new Error('APP_ASAR_MEMBER_CHANGED')
    }
    return Buffer.concat(chunks, total)
  } finally {
    await handle.close().catch(() => undefined)
  }
}
