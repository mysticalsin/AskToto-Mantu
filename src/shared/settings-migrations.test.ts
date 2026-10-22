import { describe, expect, it } from 'vitest'
import { BaseSettingsSchema, DEFAULT_SETTINGS, SettingsSchema } from './ipc'
import {
  CURRENT_SETTINGS_SCHEMA_VERSION,
  SETTINGS_MIGRATIONS,
  SETTINGS_VERSION_KEY,
  migrateLegacyBidstackConnection,
  planSettingsMigration,
  settingsFileVersion,
  type SettingsMigration
} from './settings-migrations'

describe('settings file version', () => {
  it('treats a missing version as the legacy file, and rejects anything that is not a non-negative integer', () => {
    expect(settingsFileVersion({})).toBe(0)
    expect(settingsFileVersion({ [SETTINGS_VERSION_KEY]: 1 })).toBe(1)
    for (const bad of ['1', -1, 1.5, Number.NaN, null, {}, [], true])
      expect(settingsFileVersion({ [SETTINGS_VERSION_KEY]: bad }), String(bad)).toBeNull()
  })

  it('is not a schema key, so an older reader strips it', () => {
    expect(SETTINGS_VERSION_KEY in BaseSettingsSchema.shape).toBe(false)
  })
})

describe('planSettingsMigration', () => {
  it('stamps a legacy file with the current version and keeps every key, known or not', () => {
    const raw = { temperature: 0.4, someFutureOrRetiredKey: { nested: [1, 2] } }
    const plan = planSettingsMigration(raw)
    expect(plan.status).toBe('migrate')
    if (plan.status !== 'migrate') return
    expect(plan.from).toBe(0)
    expect(plan.to).toBe(CURRENT_SETTINGS_SCHEMA_VERSION)
    expect(plan.raw).toEqual({ ...raw, [SETTINGS_VERSION_KEY]: CURRENT_SETTINGS_SCHEMA_VERSION })
    expect(plan.unknownKeys).toEqual(['someFutureOrRetiredKey'])
    expect(plan.applied).toEqual(SETTINGS_MIGRATIONS.map((m) => m.id))
  })

  it('never mutates its input', () => {
    const raw = { temperature: 0.4 }
    const frozen = Object.freeze({ ...raw })
    planSettingsMigration(frozen)
    expect(frozen).toEqual(raw)
  })

  it('leaves a current file alone and refuses a future or malformed version', () => {
    expect(planSettingsMigration({ [SETTINGS_VERSION_KEY]: CURRENT_SETTINGS_SCHEMA_VERSION })).toEqual({
      status: 'current'
    })
    expect(planSettingsMigration({ [SETTINGS_VERSION_KEY]: CURRENT_SETTINGS_SCHEMA_VERSION + 1 })).toEqual({
      status: 'future',
      version: CURRENT_SETTINGS_SCHEMA_VERSION + 1
    })
    expect(planSettingsMigration({ [SETTINGS_VERSION_KEY]: 'one' })).toMatchObject({ status: 'invalid' })
  })

  const step = (from: number, up: SettingsMigration['up'], removes?: string[]): SettingsMigration => ({
    id: `m${from}-to-${from + 1}`,
    from,
    to: from + 1,
    up,
    removes
  })

  it('runs a multi-step chain in order and reports what ran', () => {
    const migrations = [step(0, (r) => ({ ...r, a: 1 })), step(1, (r) => ({ ...r, b: (r.a as number) + 1 }))]
    const plan = planSettingsMigration({ keep: true }, { migrations, current: 2 })
    expect(plan).toMatchObject({ status: 'migrate', from: 0, to: 2, applied: ['m0-to-1', 'm1-to-2'] })
    if (plan.status === 'migrate') expect(plan.raw).toEqual({ keep: true, a: 1, b: 2, [SETTINGS_VERSION_KEY]: 2 })
  })

  it('resumes from the file version, not from zero', () => {
    const migrations = [step(0, () => ({ wrong: true })), step(1, (r) => ({ ...r, b: 2 }))]
    const plan = planSettingsMigration({ [SETTINGS_VERSION_KEY]: 1 }, { migrations, current: 2 })
    expect(plan).toMatchObject({ status: 'migrate', from: 1, applied: ['m1-to-2'] })
  })

  it('fails closed when a migration loses a key it did not declare', () => {
    const lossy = [step(0, ({ secretNote: _dropped, ...rest }) => rest)]
    const plan = planSettingsMigration({ secretNote: 'x', other: 1 }, { migrations: lossy, current: 1 })
    expect(plan).toMatchObject({ status: 'failed', reason: 'KEY_LOST', keys: ['secretNote'] })
  })

  it('allows a migration to remove a key only when it declares it', () => {
    const declared = [step(0, ({ retired: _r, ...rest }) => rest, ['retired'])]
    const plan = planSettingsMigration({ retired: 1, other: 1 }, { migrations: declared, current: 1 })
    expect(plan.status).toBe('migrate')
  })

  it('fails closed when a migration throws or the chain has a gap', () => {
    const boom = [
      step(0, () => {
        throw new Error('boom')
      })
    ]
    expect(planSettingsMigration({}, { migrations: boom, current: 1 })).toMatchObject({
      status: 'failed',
      reason: 'MIGRATION_THREW'
    })
    const gap = [step(1, (r) => r)]
    expect(planSettingsMigration({}, { migrations: gap, current: 2 })).toMatchObject({
      status: 'failed',
      reason: 'CHAIN_GAP'
    })
  })

  it('the shipped chain is additive: every migrated legacy file still parses under the unchanged schema', () => {
    const legacy = { temperature: 0.3, provider: 'anthropic', unknownLegacy: 'keep-me' }
    const plan = planSettingsMigration(legacy)
    if (plan.status !== 'migrate') throw new Error('expected a migration')
    // The older reader (store.ts getSettings) layers the file over DEFAULT_SETTINGS and parses with this schema.
    const before = SettingsSchema.parse({ ...DEFAULT_SETTINGS, ...legacy })
    const after = SettingsSchema.parse({ ...DEFAULT_SETTINGS, ...plan.raw })
    expect(after).toEqual(before)
    expect(SETTINGS_VERSION_KEY in after).toBe(false)
  })
})

describe('migrateLegacyBidstackConnection (moved from main/store.ts, behaviour unchanged)', () => {
  it('synthesizes the connection once and never when mcpConnections is present', () => {
    const raw: Record<string, unknown> = { bidstackEndpointUrl: 'https://example.invalid/mcp', bidstackConnected: true }
    migrateLegacyBidstackConnection(raw)
    expect(raw.mcpConnections).toMatchObject([{ id: 'bidstack', kind: 'bidstack', connected: true, tools: [] }])
    const cleared: Record<string, unknown> = { bidstackEndpointUrl: 'https://example.invalid/mcp', mcpConnections: [] }
    migrateLegacyBidstackConnection(cleared)
    expect(cleared.mcpConnections).toEqual([])
  })
})
