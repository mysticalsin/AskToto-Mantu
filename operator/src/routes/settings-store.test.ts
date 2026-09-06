import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { handleRequest, type Env } from '../index'
import type { D1DatabaseLike } from '../d1'
import { memoryStore } from '../store'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY } from '../test-fixtures'
import {
  DEFAULT_OPERATOR_SETTINGS,
  readOperatorSettings,
  SETTINGS_MIGRATIONS,
  validateSettingValue,
  writeOperatorSettingsPatch
} from './settings-store'

const NOW = 1_725_000_000_000

/** Same node:sqlite D1 shim as d1.store.test.ts, applied to just this table's own migration
 *  (prepared-statement reads/writes on env.DB, per the task brief). */
function sqliteD1(db: DatabaseSync): D1DatabaseLike {
  return {
    prepare(sql: string) {
      const stmt = db.prepare(sql)
      let bound: unknown[] = []
      const wrapper = {
        bind(...values: unknown[]) {
          bound = values
          return wrapper
        },
        async first<T>() {
          const row = stmt.get(...(bound as never[]))
          return (row as T) ?? null
        },
        async all<T>() {
          return { results: stmt.all(...(bound as never[])) as T[] }
        },
        async run() {
          return stmt.run(...(bound as never[]))
        }
      }
      return wrapper
    }
  }
}

function freshSettingsDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  for (const stmt of SETTINGS_MIGRATIONS) db.exec(stmt)
  return db
}

function env(): Env {
  return { OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET, OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY, OPERATOR_SKILL_PRIVATE_KEY: '' }
}

const tonyAccess = { getIdentity: async () => ({ email: 'tony.walteur@gmail.com' }) }

describe('validateSettingValue', () => {
  it('hourlyRate: 0 to 10000 or null, nothing else', () => {
    expect(validateSettingValue('hourlyRate', null)).toBeNull()
    expect(validateSettingValue('hourlyRate', 0)).toBe(0)
    expect(validateSettingValue('hourlyRate', 10000)).toBe(10000)
    expect(validateSettingValue('hourlyRate', 10000.01)).not.toBe(10000.01)
    expect(validateSettingValue('hourlyRate', -1)).not.toBe(-1)
    expect(validateSettingValue('hourlyRate', 'free')).not.toBe('free')
  })
  it('currency: exactly the five listed codes', () => {
    for (const c of ['CAD', 'EUR', 'USD', 'GBP', 'CHF']) expect(validateSettingValue('currency', c)).toBe(c)
    expect(validateSettingValue('currency', 'JPY')).not.toBe('JPY')
  })
  it('dailyTokenBudgetPerSeat: integer 0 to 50000000 or null', () => {
    expect(validateSettingValue('dailyTokenBudgetPerSeat', null)).toBeNull()
    expect(validateSettingValue('dailyTokenBudgetPerSeat', 50_000_000)).toBe(50_000_000)
    expect(validateSettingValue('dailyTokenBudgetPerSeat', 50_000_001)).not.toBe(50_000_001)
    expect(validateSettingValue('dailyTokenBudgetPerSeat', 1.5)).not.toBe(1.5)
  })
  it('density and reducedMotion: exactly their two enum values', () => {
    expect(validateSettingValue('density', 'comfortable')).toBe('comfortable')
    expect(validateSettingValue('density', 'compact')).toBe('compact')
    expect(validateSettingValue('density', 'roomy')).not.toBe('roomy')
    expect(validateSettingValue('reducedMotion', 'system')).toBe('system')
    expect(validateSettingValue('reducedMotion', 'reduce')).toBe('reduce')
  })
})

describe('readOperatorSettings / writeOperatorSettingsPatch (node:sqlite D1 shim)', () => {
  it('reads all-defaults with settingsVersion 0 when no DB is bound', async () => {
    const result = await readOperatorSettings(undefined)
    expect(result).toEqual({ values: DEFAULT_OPERATOR_SETTINGS, settingsVersion: 0 })
  })

  it('reads all-defaults with settingsVersion 0 on a migrated but empty table', async () => {
    const db = sqliteD1(freshSettingsDb())
    const result = await readOperatorSettings(db)
    expect(result).toEqual({ values: DEFAULT_OPERATOR_SETTINGS, settingsVersion: 0 })
  })

  it('writes exactly the given keys, leaves the rest at default, and reports settingsVersion as the max updated_at', async () => {
    const db = sqliteD1(freshSettingsDb())
    const result = await writeOperatorSettingsPatch(db, { hourlyRate: 65, currency: 'CAD' }, 'tony.walteur@gmail.com', NOW)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.values).toEqual({ ...DEFAULT_OPERATOR_SETTINGS, hourlyRate: 65, currency: 'CAD' })
    expect(result.settingsVersion).toBe(NOW)

    const later = await writeOperatorSettingsPatch(db, { density: 'compact' }, 'tony.walteur@gmail.com', NOW + 1000)
    if (!later.ok) throw new Error('unreachable')
    expect(later.values.hourlyRate).toBe(65) // untouched key survives a later partial patch
    expect(later.settingsVersion).toBe(NOW + 1000)
  })

  it('rejects the whole patch, writing nothing, when any key in it is invalid', async () => {
    const db = sqliteD1(freshSettingsDb())
    const result = await writeOperatorSettingsPatch(db, { hourlyRate: 50, currency: 'JPY' }, 'tony.walteur@gmail.com', NOW)
    expect(result.ok).toBe(false)
    const after = await readOperatorSettings(db)
    expect(after.values.hourlyRate).toBeNull() // the valid hourlyRate in the same patch never landed either
  })

  it('never invents a default hourly rate: hourlyRate stays null until explicitly set', async () => {
    const db = sqliteD1(freshSettingsDb())
    await writeOperatorSettingsPatch(db, { currency: 'EUR' }, 'tony.walteur@gmail.com', NOW)
    const result = await readOperatorSettings(db)
    expect(result.values.hourlyRate).toBeNull()
  })
})

describe('GET/PATCH /v1/admin/settings.json', () => {
  it('GET returns the defaults and settingsVersion 0 before anything is set', async () => {
    const db = sqliteD1(freshSettingsDb())
    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/settings.json'),
      { ...env(), DB: db },
      { access: tonyAccess },
      { store: memoryStore(), now: NOW }
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { settings: typeof DEFAULT_OPERATOR_SETTINGS; settingsVersion: number }
    expect(body.settings).toEqual(DEFAULT_OPERATOR_SETTINGS)
    expect(body.settingsVersion).toBe(0)
  })

  it('PATCH validates, persists, and audits a before/after snapshot of only the changed keys', async () => {
    const db = sqliteD1(freshSettingsDb())
    const store = memoryStore()
    const patch = await handleRequest(
      new Request('https://operator.test/v1/admin/settings.json', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hourlyRate: 42, currency: 'GBP' })
      }),
      { ...env(), DB: db },
      { access: tonyAccess },
      { store, now: NOW }
    )
    expect(patch.status).toBe(200)
    const patchBody = (await patch.json()) as { settings: { hourlyRate: number | null; currency: string } }
    expect(patchBody.settings.hourlyRate).toBe(42)
    expect(patchBody.settings.currency).toBe('GBP')

    const auditRows = await store.listAudit(10, { action: 'settings-update' })
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0].detail).toContain('"hourlyRate":null')
    expect(auditRows[0].detail).toContain('"hourlyRate":42')

    const get = await handleRequest(
      new Request('https://operator.test/v1/admin/settings.json'),
      { ...env(), DB: db },
      { access: tonyAccess },
      { store, now: NOW + 1000 }
    )
    const getBody = (await get.json()) as { settings: { hourlyRate: number | null } }
    expect(getBody.settings.hourlyRate).toBe(42)
  })

  it('PATCH rejects an out-of-range hourlyRate with 400 and writes nothing', async () => {
    const db = sqliteD1(freshSettingsDb())
    const store = memoryStore()
    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/settings.json', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hourlyRate: 999999 })
      }),
      { ...env(), DB: db },
      { access: tonyAccess },
      { store, now: NOW }
    )
    expect(res.status).toBe(400)
    const rows = await readOperatorSettings(db)
    expect(rows.values.hourlyRate).toBeNull()
    expect(await store.listAudit(10, { action: 'settings-update' })).toHaveLength(0)
  })

  it('PATCH with no recognised key returns 400', async () => {
    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/settings.json', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ notARealSetting: 1 })
      }),
      { ...env(), DB: sqliteD1(freshSettingsDb()) },
      { access: tonyAccess },
      { store: memoryStore(), now: NOW }
    )
    expect(res.status).toBe(400)
  })

  it('requires admin auth', async () => {
    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/settings.json'),
      env(),
      { access: { getIdentity: async () => null } },
      { store: memoryStore(), now: NOW }
    )
    expect(res.status).toBe(401)
  })
})
