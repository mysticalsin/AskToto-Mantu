import { statSync } from 'node:fs'
import { adminManagedConfigPath, readTrustedAdminManaged } from './win-security'

// Trust checks and reads remain tied to the verified fd in readTrustedAdminManaged.
const ADMIN_POLICY_REPROBE_MS = 60_000
let snapshot: {
  path: string
  mtime: number
  dev: number
  ino: number
  at: number
  content: string | null
} | null = null

function identity(path: string): { path: string; mtime: number; dev: number; ino: number } {
  try {
    const stat = statSync(path)
    return { path, mtime: stat.mtimeMs, dev: stat.dev, ino: stat.ino }
  } catch {
    return { path, mtime: 0, dev: 0, ino: 0 }
  }
}

export function resetAdminManagedCache(): void {
  snapshot = null
}

export const resetAdminManagedCacheForTests = resetAdminManagedCache

/** Path/device/inode/mtime and a bounded age prevent stale replacement and clock rollback snapshots. */
export function adminManagedContent(): string | null {
  const id = identity(adminManagedConfigPath())
  const now = Date.now()
  const cached = snapshot
  if (
    cached &&
    cached.path === id.path &&
    cached.mtime === id.mtime &&
    cached.dev === id.dev &&
    cached.ino === id.ino &&
    now - cached.at >= 0 &&
    now - cached.at < ADMIN_POLICY_REPROBE_MS
  )
    return cached.content
  const content = readTrustedAdminManaged()
  snapshot = { ...id, at: now, content }
  return content
}
