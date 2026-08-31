/**
 * License cache in the OS secret store.
 * Packaged + encryption available: Electron safeStorage (Keychain / DPAPI).
 * Dev / Linux CI: the existing file-backend (encryptSecret).
 * Never write a raw license key to settings.json.
 */
import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { decryptSecret, encryptSecret, useFileBackend } from '../secrets'
import type { LicenseEdition, LicenseSource } from '@shared/license-types'

const CacheSchema = z.object({
  jws: z.string().min(1),
  cachedAt: z.number().int().nonnegative(),
  kid: z.string().min(1),
  edition: z.enum(['personal', 'pro', 'enterprise']),
  source: z.enum(['cache', 'mdm', 'file', 'none']).transform((s) => (s === 'none' ? 'cache' : s))
})
export type LicenseCache = {
  jws: string
  cachedAt: number
  kid: string
  edition: LicenseEdition
  source: Exclude<LicenseSource, 'none'>
}

export function licenseCachePath(userData?: string): string {
  return join(userData ?? app.getPath('userData'), 'license-cache.bin')
}

function wrap(plain: string): Buffer {
  try {
    if (!useFileBackend() && safeStorage.isEncryptionAvailable()) {
      return safeStorage.encryptString(plain)
    }
  } catch {
    /* fall through to file backend */
  }
  return encryptSecret(plain)
}

function unwrap(buf: Buffer): string | null {
  try {
    if (!useFileBackend() && safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(buf)
    }
  } catch {
    /* try file backend */
  }
  try {
    return decryptSecret(buf)
  } catch {
    return null
  }
}

export function readLicenseCache(userData?: string): LicenseCache | null {
  const path = licenseCachePath(userData)
  try {
    if (!existsSync(path)) return null
    const raw = unwrap(readFileSync(path))
    if (!raw) return null
    const parsed = CacheSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) return null
    return parsed.data as LicenseCache
  } catch {
    return null
  }
}

export function writeLicenseCache(cache: LicenseCache, userData?: string): void {
  const path = licenseCachePath(userData)
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const buf = wrap(JSON.stringify(cache))
  writeFileSync(path, buf, { mode: 0o600 })
}

export function clearLicenseCache(userData?: string): void {
  const path = licenseCachePath(userData)
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch {
    /* missing is a cleared cache */
  }
}
