import type { BigIntStats } from 'node:fs'
import { assertRuntimeDirectoryIdentitySync, sameRuntimeFileVersion } from '../../../infra/storage/runtime-owned-files'

type DirectoryIdentity = Pick<BigIntStats, 'dev' | 'ino' | 'birthtimeNs'>

export function sameFileVersion(a: BigIntStats | null, b: BigIntStats | null): boolean {
  return sameRuntimeFileVersion(a, b)
}

export function sameFileOwnerAfterRename(a: BigIntStats | null, b: BigIntStats | null): boolean {
  return (
    a !== null &&
    b !== null &&
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
    a.birthtimeNs === b.birthtimeNs
  )
}

export function createRuntimePointerSnapshotGuards(input: {
  readonly storeRoot: string
  readonly activeRoot: string
  readonly storeRootIdentity: DirectoryIdentity
  readonly activeRootIdentity: DirectoryIdentity
  readonly sameFileVersion: (a: BigIntStats | null, b: BigIntStats | null) => boolean
}): {
  assertActiveRootOwnedSync(): void
} {
  const assertActiveRootOwnedSync = (): void => {
    assertRuntimeDirectoryIdentitySync(input)
  }
  return { assertActiveRootOwnedSync }
}
