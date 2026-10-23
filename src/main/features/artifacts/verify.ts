import type { ArtifactRecord } from '@shared/artifact'
import type { ArtifactFileStat, ArtifactFs } from './artifact-fs'

export interface FileFingerprint {
  size: number
  mtimeMs: number
  ino: number
}

export type Verification =
  | { status: 'ready'; fingerprint: FileFingerprint }
  | { status: 'missing' }
  | { status: 'changed' }

export const fingerprintOf = (stat: ArtifactFileStat): FileFingerprint => ({
  size: stat.size,
  mtimeMs: stat.mtimeMs,
  ino: stat.ino
})

/**
 * Existence plus digest: the file at the recorded path must be a regular file (never a symlink swapped in), the size
 * must match, and the SHA-256 must equal the recorded one. Anything else is shown as moved or changed.
 */
export async function verifyArtifactFile(record: ArtifactRecord, fs: ArtifactFs): Promise<Verification> {
  const stat = await fs.lstat(record.path)
  if (!stat) return { status: 'missing' }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== record.bytes) return { status: 'changed' }
  let digest: string
  try {
    digest = await fs.sha256(record.path)
  } catch {
    return { status: 'missing' }
  }
  if (digest !== record.sha256) return { status: 'changed' }
  // The file may have changed while it was hashed; the fingerprint is the one seen after the digest.
  const after = await fs.lstat(record.path)
  if (!after || after.isSymbolicLink() || !after.isFile() || after.size !== record.bytes) return { status: 'changed' }
  return { status: 'ready', fingerprint: fingerprintOf(after) }
}

/** Whether the file still looks exactly as it did when it was verified (cheap: no digest). */
export async function matchesFingerprint(
  record: ArtifactRecord,
  expected: FileFingerprint,
  fs: ArtifactFs
): Promise<boolean> {
  const stat = await fs.lstat(record.path)
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) return false
  const now = fingerprintOf(stat)
  return now.size === expected.size && now.mtimeMs === expected.mtimeMs && now.ino === expected.ino
}
