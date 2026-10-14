import { constants as fsConstants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'

export type BoundedTextRead = { kind: 'absent' } | { kind: 'invalid' } | { kind: 'present'; text: string }

function isMissingPathError(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'ENOENT'
}

function stableFileSnapshot(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>
): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

export async function readBoundedTextFile(path: string, maxBytes: number): Promise<BoundedTextRead> {
  let before: Awaited<ReturnType<typeof lstat>>
  try {
    before = await lstat(path)
  } catch (error) {
    return isMissingPathError(error) ? { kind: 'absent' } : { kind: 'invalid' }
  }
  if (before.isSymbolicLink() || !before.isFile() || before.size < 0 || before.size > maxBytes)
    return { kind: 'invalid' }
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0))
    const opened = await handle.stat()
    if (!stableFileSnapshot(before, opened)) return { kind: 'invalid' }
    const bytes = Buffer.alloc(maxBytes + 1)
    let bytesRead = 0
    while (bytesRead < bytes.byteLength) {
      const result = await handle.read(bytes, bytesRead, bytes.byteLength - bytesRead, null)
      if (result.bytesRead === 0) break
      bytesRead += result.bytesRead
    }
    const pathAfter = await lstat(path)
    const fdAfter = await handle.stat()
    if (bytesRead > maxBytes || !stableFileSnapshot(before, pathAfter) || !stableFileSnapshot(before, fdAfter)) {
      return { kind: 'invalid' }
    }
    return {
      kind: 'present',
      text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead))
    }
  } catch {
    return { kind: 'invalid' }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export async function readTrustedAdminText(
  path: string,
  readBytes: (path: string) => Promise<Uint8Array | null>
): Promise<BoundedTextRead> {
  let before: Awaited<ReturnType<typeof lstat>>
  try {
    before = await lstat(path)
  } catch (error) {
    return isMissingPathError(error) ? { kind: 'absent' } : { kind: 'invalid' }
  }
  if (before.isSymbolicLink() || !before.isFile() || before.size > 1_048_576) return { kind: 'invalid' }
  const bytes = await readBytes(path)
  if (bytes === null || bytes.byteLength > 1_048_576) return { kind: 'invalid' }
  try {
    const after = await lstat(path)
    if (!stableFileSnapshot(before, after)) return { kind: 'invalid' }
    return { kind: 'present', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  } catch {
    return { kind: 'invalid' }
  }
}
