/**
 * The versions of files this process itself wrote into place. Bytes this process has just written are on
 * this device, so the storage gateway answers 'local' for exactly that version without a placeholder probe.
 * The probe is a child process (a cold powershell.exe on Windows) that can outlive the gateway's read
 * deadline on a slow machine; before this, a meeting an import had just saved read back as 'degraded' or
 * 'unknown', and History showed "Could not read the meeting file." for a file that was never cloud-only.
 *
 * Invariant: a record matches only the exact stat version (mtime, ctime, size) seen right after the write.
 * Any later change — another writer, or a sync client dehydrating the file, which changes its attributes
 * and so its ctime — is a new version the dataless detector decides, exactly as before.
 */
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { FileVersion } from './dataless'

/** Same bound as the detector's own version cache. Insertion order is eviction order. */
const MAX_WRITTEN_VERSIONS = 10_000

const written = new Map<string, Omit<FileVersion, 'path'>>()

/** Record `path` as written by this process, at its current version. Call right after the write lands.
 *  Never throws: a failed stat forgets the path, which leaves the file to the probe. */
export async function recordLocalWrite(path: string): Promise<void> {
  const key = resolve(path)
  written.delete(key)
  try {
    const { mtimeMs, ctimeMs, size } = await stat(key)
    written.set(key, { mtimeMs, ctimeMs, size })
  } catch {
    return
  }
  if (written.size > MAX_WRITTEN_VERSIONS) {
    const oldest = written.keys().next()
    if (!oldest.done) written.delete(oldest.value)
  }
}

/** Whether this exact version of the file is one this process wrote. */
export function isLocalWrite(file: FileVersion): boolean {
  const hit = written.get(resolve(file.path))
  return !!hit && hit.mtimeMs === file.mtimeMs && hit.ctimeMs === file.ctimeMs && hit.size === file.size
}
