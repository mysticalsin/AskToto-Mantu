import type { BigIntStats } from 'node:fs'

export function sameRuntimeFileVersion(a: BigIntStats | null, b: BigIntStats | null): boolean {
  return a === null || b === null
    ? a === b
    : a.dev === b.dev &&
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
}
