import { constants } from 'node:fs'
import { lstat, open, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { verifyPrivateCurrentUserAcl } from '../win-security'
import type { OpaqueOperationScope, OwnedMeetingRoot, RootRegistry } from './root-registry'

export const PROTECTED_KEY_FILE = 'meeting-key.v2'

function ownedByCurrentProcess(uid: number | bigint): boolean {
  return process.platform === 'win32' || process.getuid?.() === Number(uid)
}

/** Physically bounded, held-descriptor read for one admitted protected-key file. */
export async function readProtectedKeyFile(
  roots: RootRegistry,
  scope: OpaqueOperationScope,
  root: OwnedMeetingRoot,
  maxRecordBytes: number
): Promise<Buffer> {
  roots.assertScopeCurrent(scope, root)
  root.assertCurrent()
  await root.assertPhysicalCurrent()
  const path = join(root.meetingPath, PROTECTED_KEY_FILE)
  const before = await lstat(path, { bigint: true })
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    !ownedByCurrentProcess(before.uid) ||
    before.size <= 0n ||
    before.size > BigInt(maxRecordBytes)
  ) {
    throw new Error('Protected key record is unavailable or invalid; original bytes were preserved')
  }
  if (process.platform !== 'win32' && (Number(before.mode) & 0o077) !== 0)
    throw new Error('Protected key record permissions are not private')
  const file: FileHandle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  )
  try {
    const opened = await file.stat({ bigint: true })
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      opened.uid !== before.uid ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.size > BigInt(maxRecordBytes)
    ) {
      throw new Error('Protected key record physical version changed; original bytes were preserved')
    }
    if (process.platform === 'win32') {
      if (!(await verifyPrivateCurrentUserAcl(path)))
        throw new Error('Protected key record Windows ACL is not private to the current process owner')
      const [afterAcl, heldAfterAcl] = await Promise.all([lstat(path, { bigint: true }), file.stat({ bigint: true })])
      roots.assertScopeCurrent(scope, root)
      await root.assertPhysicalCurrent()
      if (
        !afterAcl.isFile() ||
        afterAcl.isSymbolicLink() ||
        afterAcl.nlink !== 1n ||
        afterAcl.uid !== opened.uid ||
        afterAcl.dev !== opened.dev ||
        afterAcl.ino !== opened.ino ||
        heldAfterAcl.dev !== opened.dev ||
        heldAfterAcl.ino !== opened.ino
      ) {
        throw new Error('Protected key record changed during Windows ACL verification')
      }
    }
    const bounded = Buffer.alloc(maxRecordBytes + 1)
    let bytesRead = 0
    while (bytesRead < bounded.byteLength) {
      const next = await file.read(bounded, bytesRead, bounded.byteLength - bytesRead, bytesRead)
      if (next.bytesRead === 0) break
      bytesRead += next.bytesRead
    }
    const [after, finalStat] = await Promise.all([lstat(path, { bigint: true }), file.stat({ bigint: true })])
    roots.assertScopeCurrent(scope, root)
    await root.assertPhysicalCurrent()
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.nlink !== 1n ||
      !ownedByCurrentProcess(after.uid) ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      bytesRead > maxRecordBytes ||
      BigInt(bytesRead) !== opened.size ||
      finalStat.dev !== opened.dev ||
      finalStat.ino !== opened.ino ||
      finalStat.nlink !== 1n ||
      finalStat.uid !== opened.uid ||
      finalStat.size !== opened.size ||
      finalStat.mtimeNs !== opened.mtimeNs ||
      after.mtimeNs !== opened.mtimeNs
    ) {
      bounded.fill(0)
      throw new Error('Protected key record changed during bounded read; original bytes were preserved')
    }
    const exact = Buffer.from(bounded.subarray(0, bytesRead))
    bounded.fill(0)
    return exact
  } finally {
    await file.close()
  }
}
