import { lstat } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'

export type PhysicalPathKind = 'directory' | 'file'

export interface PhysicalOwner {
  dev: bigint
  ino: bigint
}

export interface PhysicalPathVersion extends PhysicalOwner {
  kind: PhysicalPathKind
  mode: bigint
  nlink: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}

export function physicalPathVersionFromStats(stat: BigIntStats, kind: PhysicalPathKind): PhysicalPathVersion {
  return {
    dev: stat.dev,
    ino: stat.ino,
    kind,
    mode: stat.mode,
    nlink: stat.nlink,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs
  }
}

export function samePhysicalPathVersion(left: PhysicalPathVersion, right: PhysicalPathVersion): boolean {
  return (
    left.kind === right.kind &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

export async function capturePhysicalOwner(path: string, kind: PhysicalPathKind): Promise<PhysicalOwner | null> {
  const version = await capturePhysicalPathVersion(path, kind)
  return version ? { dev: version.dev, ino: version.ino } : null
}

export async function capturePhysicalPathVersion(
  path: string,
  kind: PhysicalPathKind
): Promise<PhysicalPathVersion | null> {
  try {
    const stat = await lstat(path, { bigint: true })
    if (stat.isSymbolicLink() || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())) return null
    if (kind === 'file' && stat.nlink !== 1n) return null
    return physicalPathVersionFromStats(stat, kind)
  } catch {
    return null
  }
}

export async function physicalOwnerMatches(
  path: string,
  owner: PhysicalOwner,
  kind: PhysicalPathKind
): Promise<boolean> {
  const current = await capturePhysicalOwner(path, kind)
  return current !== null && current.dev === owner.dev && current.ino === owner.ino
}

export async function physicalPathVersionMatches(path: string, expected: PhysicalPathVersion): Promise<boolean> {
  const current = await capturePhysicalPathVersion(path, expected.kind)
  return current !== null && samePhysicalPathVersion(current, expected)
}
