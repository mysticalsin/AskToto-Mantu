import { constants as fsConstants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import {
  assertAuthoritySourcePinCurrent,
  captureAuthoritySourcePin,
  isAuthoritySourcePinAbsent,
  sameAuthoritySourcePinIdentity,
  type AuthoritySourcePin
} from './win-security'

export type BoundedTextRead = { kind: 'absent' } | { kind: 'invalid' } | { kind: 'present'; text: string }
const boundedReadPins = new WeakMap<object, AuthoritySourcePin>()

function retainPin<T extends BoundedTextRead>(read: T, pin: AuthoritySourcePin): T {
  boundedReadPins.set(read as object, pin)
  return read
}

/** Revalidate the exact bounded read's original source, including a verified absence witness. */
export async function assertBoundedTextReadCurrent(read: BoundedTextRead): Promise<void> {
  const pin = boundedReadPins.get(read as object)
  if (!pin || read.kind === 'invalid') throw new Error('Unknown or invalid bounded authority read')
  await assertAuthoritySourcePinCurrent(pin)
}

export function sameBoundedTextReadSource(left: BoundedTextRead, right: BoundedTextRead): boolean {
  const leftPin = boundedReadPins.get(left as object)
  const rightPin = boundedReadPins.get(right as object)
  return !!leftPin && !!rightPin && sameAuthoritySourcePinIdentity(leftPin, rightPin)
}

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
  const sourcePin = await captureAuthoritySourcePin(path)
  if (!sourcePin) return { kind: 'invalid' }
  let before: Awaited<ReturnType<typeof lstat>>
  try {
    before = await lstat(path)
  } catch (error) {
    if (!isMissingPathError(error)) return { kind: 'invalid' }
    try {
      if (!isAuthoritySourcePinAbsent(sourcePin)) return { kind: 'invalid' }
      await assertAuthoritySourcePinCurrent(sourcePin)
      return retainPin(Object.freeze({ kind: 'absent' as const }), sourcePin)
    } catch {
      return { kind: 'invalid' }
    }
  }
  if (before.isSymbolicLink() || !before.isFile() || before.size < 0 || before.size > maxBytes)
    return { kind: 'invalid' }
  let handle: Awaited<ReturnType<typeof open>> | null = null
  let verifiedRead: BoundedTextRead | null = null
  let closeFailed = false
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
    await assertAuthoritySourcePinCurrent(sourcePin)
    verifiedRead = Object.freeze({
      kind: 'present',
      text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead))
    })
  } catch {
    return { kind: 'invalid' }
  } finally {
    try {
      await handle?.close()
    } catch {
      closeFailed = true
    }
  }
  if (!verifiedRead || closeFailed) return { kind: 'invalid' }
  return retainPin(verifiedRead, sourcePin)
}

export async function readTrustedAdminText(
  path: string,
  readBytes: (path: string) => Promise<Uint8Array | null>
): Promise<BoundedTextRead> {
  const sourcePin = await captureAuthoritySourcePin(path)
  if (!sourcePin) return { kind: 'invalid' }
  let before: Awaited<ReturnType<typeof lstat>>
  try {
    before = await lstat(path)
  } catch (error) {
    if (!isMissingPathError(error)) return { kind: 'invalid' }
    try {
      if (!isAuthoritySourcePinAbsent(sourcePin)) return { kind: 'invalid' }
      await assertAuthoritySourcePinCurrent(sourcePin)
      return retainPin(Object.freeze({ kind: 'absent' as const }), sourcePin)
    } catch {
      return { kind: 'invalid' }
    }
  }
  if (before.isSymbolicLink() || !before.isFile() || before.size > 1_048_576) return { kind: 'invalid' }
  const bytes = await readBytes(path)
  if (bytes === null || bytes.byteLength > 1_048_576) return { kind: 'invalid' }
  try {
    const after = await lstat(path)
    if (!stableFileSnapshot(before, after)) return { kind: 'invalid' }
    await assertAuthoritySourcePinCurrent(sourcePin)
    return retainPin(
      Object.freeze({ kind: 'present' as const, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }),
      sourcePin
    )
  } catch {
    return { kind: 'invalid' }
  }
}
