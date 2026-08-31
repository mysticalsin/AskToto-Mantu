/**
 * Air-gap license.metis parser + optional MDM path detect.
 * Presence is not a license. Activation stays closed in this change.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { verifyLicenseJws, type VerifyResult } from './jws'

export function managedLicensePath(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return '/Library/Application Support/Métis/license.metis'
  if (platform === 'win32') {
    const root = process.env.PROGRAMDATA || 'C:\\ProgramData'
    return join(root, 'Métis', 'license.metis')
  }
  return '/etc/metis/license.metis'
}

export function managedLicensePresent(platform: NodeJS.Platform = process.platform): boolean {
  try {
    return existsSync(managedLicensePath(platform))
  } catch {
    return false
  }
}

export function extractJwsFromLicenseFile(raw: string): string | null {
  const text = raw.trim()
  if (!text) return null
  if (text.startsWith('{')) {
    try {
      const obj = JSON.parse(text) as { jws?: unknown }
      return typeof obj.jws === 'string' && obj.jws.trim() ? obj.jws.trim() : null
    } catch {
      return null
    }
  }
  // Compact JWS: three base64url segments.
  const parts = text.split('.')
  if (parts.length === 3 && parts.every((p) => p.length > 0)) return text
  return null
}

export function parseLicenseMetis(
  raw: string,
  opts?: { expectedSub?: string; nowMs?: number; keys?: Record<string, string> }
): VerifyResult | { ok: false; error: 'invalid' } {
  const jws = extractJwsFromLicenseFile(raw)
  if (!jws) return { ok: false, error: 'invalid' }
  return verifyLicenseJws(jws, opts)
}

export function readManagedLicenseFile(platform: NodeJS.Platform = process.platform): string | null {
  try {
    const path = managedLicensePath(platform)
    if (!existsSync(path)) return null
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}
