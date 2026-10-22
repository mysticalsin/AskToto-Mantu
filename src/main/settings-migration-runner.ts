/**
 * Applies the versioned settings migrations (shared/settings-migrations.ts) to the settings file on disk.
 *
 * Async fs only (FF-05a). Order of operations, and what each failure leaves behind:
 *   1. read + decode the file. Missing, unreadable or undecodable: do nothing; the original stays as it is
 *      (store.ts already serves safe defaults and refuses writes for an unreadable profile);
 *   2. plan. Current: do nothing. Newer than this build or a malformed version: do nothing, never rewrite;
 *   3. back the original up to `settings.json.pre-v<from>.bak` (exclusive create, so an older backup is never
 *      overwritten). A backup of a legacy plaintext file is written encrypted, so no plaintext copy appears.
 *      No backup, no rewrite;
 *   4. write the migrated profile (encrypted by the injected encoder) to a temp file, check the live file is
 *      still the bytes we read (a settings save that landed meanwhile wins, and the next boot retries), then
 *      rename it over the original.
 * The managed-policy layer is never read or merged here, so locks keep their meaning.
 */
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import {
  CURRENT_SETTINGS_SCHEMA_VERSION,
  planSettingsMigration,
  settingsFileVersion
} from '@shared/settings-migrations'

export interface SettingsFileCodec {
  /** Decode the stored bytes, or null if they cannot be read. `encrypted` says the bytes were not plaintext. */
  decode(buf: Buffer): { raw: Record<string, unknown>; encrypted: boolean } | null
  /** Serialize a profile for disk, encrypted at rest. May throw when encryption is unavailable. */
  encode(raw: Record<string, unknown>): Buffer
}

export interface SettingsMigrationLog {
  warn(message: string): void
  info?(message: string): void
}

export type SettingsMigrationResult =
  | { status: 'missing' | 'unreadable' | 'current' | 'changed' }
  | { status: 'future'; version: number }
  | { status: 'failed'; reason: 'INVALID_VERSION' | 'PLAN_FAILED' | 'BACKUP_FAILED' | 'WRITE_FAILED' }
  | { status: 'migrated'; from: number; to: number; backupPath: string; unknownKeys: number }

export async function migrateSettingsFile(
  options: SettingsFileCodec & { path: string; log: SettingsMigrationLog; onWritten?: () => void }
): Promise<SettingsMigrationResult> {
  const { path, log } = options
  let original: Buffer
  try {
    original = await readFile(path)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { status: 'missing' } : { status: 'unreadable' }
  }
  const decoded = options.decode(original)
  if (!decoded) return { status: 'unreadable' }

  const plan = planSettingsMigration(decoded.raw)
  if (plan.status === 'current') return { status: 'current' }
  if (plan.status === 'future') {
    log.warn(`[settings] settings.json is version ${plan.version}, newer than this build; leaving it untouched`)
    return { status: 'future', version: plan.version }
  }
  if (plan.status === 'invalid') {
    log.warn('[settings] settings.json has a malformed schema version; leaving it untouched')
    return { status: 'failed', reason: 'INVALID_VERSION' }
  }
  if (plan.status === 'failed') {
    log.warn(`[settings] migration ${plan.migration ?? ''} refused (${plan.reason}); leaving settings.json untouched`)
    return { status: 'failed', reason: 'PLAN_FAILED' }
  }

  const backupPath = `${path}.pre-v${plan.from}.bak`
  let createdBackup = false
  try {
    const backupBytes = decoded.encrypted ? original : options.encode(decoded.raw)
    try {
      await writeFile(backupPath, backupBytes, { flag: 'wx', mode: 0o600 })
      createdBackup = true
    } catch (error) {
      // An earlier attempt already backed this version up: keep it, but only if it really is a file.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !(await stat(backupPath)).isFile()) throw error
    }
  } catch {
    log.warn('[settings] could not back up settings.json before migrating; leaving it untouched')
    return { status: 'failed', reason: 'BACKUP_FAILED' }
  }

  const tmp = `${path}.tmp`
  try {
    await writeFile(tmp, options.encode(plan.raw), { mode: 0o600 })
    if (!(await readFile(path)).equals(original)) {
      await rm(tmp, { force: true })
      if (createdBackup) await rm(backupPath, { force: true })
      return { status: 'changed' }
    }
    await rename(tmp, path)
  } catch {
    await rm(tmp, { force: true }).catch(() => undefined)
    log.warn('[settings] could not write the migrated settings.json; the original is untouched')
    return { status: 'failed', reason: 'WRITE_FAILED' }
  }
  options.onWritten?.()
  log.info?.(
    `[settings] migrated settings.json v${plan.from} -> v${plan.to} (${plan.unknownKeys.length} unrecognised keys kept); backup at ${backupPath}`
  )
  return { status: 'migrated', from: plan.from, to: plan.to, backupPath, unknownKeys: plan.unknownKeys.length }
}

/** Codec over a store's own parse and serialize functions. `markers` are the at-rest encryption prefixes. */
export function settingsCodec(
  parse: (buf: Buffer) => Record<string, unknown> | null,
  markers: readonly Buffer[],
  encode: (raw: Record<string, unknown>) => Buffer
): SettingsFileCodec {
  return {
    decode: (buf) => {
      const raw = parse(buf)
      return raw && { raw, encrypted: markers.some((m) => buf.subarray(0, m.length).equals(m)) }
    },
    encode
  }
}

let warnedUnsupportedVersion = false
/**
 * Read-side guard: a profile written by a NEWER build, or with a malformed version, is treated as unreadable
 * (null). The caller then serves safe defaults and refuses to write, so the original is never rewritten or
 * deleted. Older and current profiles pass through; the boot migration upgrades the older ones.
 */
export function rejectUnsupportedSettingsVersion(
  raw: Record<string, unknown> | null,
  log: SettingsMigrationLog
): Record<string, unknown> | null {
  if (!raw) return raw
  const version = settingsFileVersion(raw)
  if (version !== null && version <= CURRENT_SETTINGS_SCHEMA_VERSION) return raw
  if (!warnedUnsupportedVersion)
    log.warn('[store] settings.json has a newer or malformed schema version; serving defaults and leaving it untouched')
  warnedUnsupportedVersion = true
  return null
}
