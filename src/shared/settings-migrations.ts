/**
 * Versioned migrations for the persisted settings file (pure; the main-process runner does the I/O).
 *
 * The version lives in the file under `settingsSchemaVersion`, beside the settings and NOT in
 * `BaseSettingsSchema`: an older build parses the file with the unchanged schema, which strips the key, so the
 * file stays readable by the build it came from (rollback). A file with no version is version 0.
 *
 * Invariants of the plan:
 *   - a migration may not lose a key. Output must hold every input key unless the migration lists it in
 *     `removes`; a violation fails the plan and the original file is left alone;
 *   - unknown keys (legacy, retired or written by a newer build) pass through untouched;
 *   - a file newer than this build, or with a malformed version, is refused, never rewritten;
 *   - the input is never mutated.
 *
 * Adding a migration: append `{ id, from, to: from + 1, up }` and raise CURRENT_SETTINGS_SCHEMA_VERSION. Keep
 * it additive (new keys with defaults); renames must keep the old key readable so rollback still works.
 * The load-time repairs in main/store.ts getSettings (retired providers and models, the overlay layout, the
 * BidStack connection) stay transient on purpose and are not versioned migrations.
 */
import { isRegisteredSettingKey } from './settings-registry'

export const SETTINGS_VERSION_KEY = 'settingsSchemaVersion'
export const CURRENT_SETTINGS_SCHEMA_VERSION = 1

export interface SettingsMigration {
  readonly id: string
  readonly from: number
  readonly to: number
  /** Return a new object; never mutate `raw`. */
  readonly up: (raw: Readonly<Record<string, unknown>>) => Record<string, unknown>
  /** Keys this migration deliberately drops. Anything else it drops fails the plan. */
  readonly removes?: readonly string[]
}

export const SETTINGS_MIGRATIONS: readonly SettingsMigration[] = [
  // Version 0 is any file written before versioning existed. Reading it needed no change, so this step only
  // stamps the version; the backup it triggers is the safety net for the steps that follow.
  { id: 'stamp-schema-version', from: 0, to: 1, up: (raw) => ({ ...raw }) }
]

export type SettingsMigrationPlan =
  | { status: 'current' }
  | { status: 'future'; version: number }
  | { status: 'invalid'; reason: 'BAD_VERSION' }
  | { status: 'failed'; reason: 'KEY_LOST' | 'MIGRATION_THREW' | 'CHAIN_GAP'; keys?: string[]; migration?: string }
  | {
      status: 'migrate'
      from: number
      to: number
      raw: Record<string, unknown>
      applied: string[]
      /** Keys the current schema does not know. They are kept as they are. */
      unknownKeys: string[]
    }

/** The file's version: 0 when absent, null when present but not a non-negative integer. */
export function settingsFileVersion(raw: Readonly<Record<string, unknown>>): number | null {
  if (!Object.hasOwn(raw, SETTINGS_VERSION_KEY)) return 0
  const version = raw[SETTINGS_VERSION_KEY]
  return typeof version === 'number' && Number.isInteger(version) && version >= 0 ? version : null
}

export function planSettingsMigration(
  raw: Readonly<Record<string, unknown>>,
  options: { migrations?: readonly SettingsMigration[]; current?: number } = {}
): SettingsMigrationPlan {
  const migrations = options.migrations ?? SETTINGS_MIGRATIONS
  const current = options.current ?? CURRENT_SETTINGS_SCHEMA_VERSION
  const from = settingsFileVersion(raw)
  if (from === null) return { status: 'invalid', reason: 'BAD_VERSION' }
  if (from > current) return { status: 'future', version: from }
  if (from === current) return { status: 'current' }

  let working: Record<string, unknown> = { ...raw }
  let version = from
  const applied: string[] = []
  while (version < current) {
    const step = migrations.find((m) => m.from === version)
    if (!step || step.to !== version + 1) return { status: 'failed', reason: 'CHAIN_GAP', migration: `v${version}` }
    let next: Record<string, unknown>
    try {
      next = step.up(working)
    } catch {
      return { status: 'failed', reason: 'MIGRATION_THREW', migration: step.id }
    }
    const removed = new Set(step.removes ?? [])
    const lost = Object.keys(working).filter((key) => !removed.has(key) && !Object.hasOwn(next, key))
    if (lost.length) return { status: 'failed', reason: 'KEY_LOST', keys: lost, migration: step.id }
    working = next
    version = step.to
    applied.push(step.id)
  }
  working[SETTINGS_VERSION_KEY] = current
  const unknownKeys = Object.keys(working).filter((key) => key !== SETTINGS_VERSION_KEY && !isRegisteredSettingKey(key))
  return { status: 'migrate', from, to: current, raw: working, applied, unknownKeys }
}

/**
 * Synthesize a `mcpConnections: [{ id: 'bidstack', ... }]` entry from the pre-generalization
 * bidstackEndpointUrl/bidstackConnected/bidstackTools fields, IN PLACE on `raw`. A no-op whenever the
 * `mcpConnections` KEY IS PRESENT AT ALL in raw, including an explicit empty array (checking `.length > 0`
 * would treat a deliberate disconnect's `[]` as "never migrated" and keep resurrecting the cleared connection).
 * Transient: getSettings recomputes it on every read and never rewrites settings.json for it. Moved here from
 * main/store.ts with no change in behaviour.
 */
export function migrateLegacyBidstackConnection(raw: Record<string, unknown>): void {
  if ('mcpConnections' in raw) return
  const legacyUrl = raw.bidstackEndpointUrl
  if (typeof legacyUrl !== 'string' || !legacyUrl.trim()) return
  raw.mcpConnections = [
    {
      id: 'bidstack',
      kind: 'bidstack',
      label: 'Polo Pre-Sales',
      endpointUrl: legacyUrl,
      connected: Boolean(raw.bidstackConnected),
      tools: Array.isArray(raw.bidstackTools) ? raw.bidstackTools : [],
      extraHeaders: {}
    }
  ]
}
