import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { d1Store, type D1DatabaseLike } from '../d1'
import type { IntegrationRow } from '../store'
import {
  deleteIntegrationRow,
  INTEGRATION_ALTERS,
  INTEGRATION_EXTRA_DEFAULTS,
  readIntegrationExtra,
  readIntegrationExtraColumns,
  withIntegrationExtra,
  writeIntegrationExtraColumns,
  type IntegrationExtraColumns
} from './data'

/** Same shim `d1.store.test.ts` uses: real SQLite underneath so the ALTERs and the hand-written SQL in
 *  `data.ts` run against the actual engine, not a mock. */
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

/** `schema.sql` plus this task's own ALTERs, exactly as `migrate.mjs` would leave a real D1 after this
 *  task's migration runs (schema.sql itself is never edited for these columns; only schema-alter.sql
 *  carries them, appended verbatim from `INTEGRATION_ALTERS`). */
function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  const schema = readFileSync(join(__dirname, '..', '..', 'schema.sql'), 'utf8')
  db.exec(schema)
  for (const stmt of INTEGRATION_ALTERS) db.exec(stmt)
  return db
}

function baseRow(id: string): IntegrationRow {
  return {
    id,
    kind: 'hubspot',
    label: 'Hubspot prod',
    base_url: 'https://api.hubapi.com',
    cipher: 'c',
    iv: 'i',
    last4: 'abcd',
    scope_json: '{}',
    status: 'active',
    created_at: 1000,
    created_by: 'tony.walteur@gmail.com',
    rotated_at: null,
    revoked_at: null,
    last_used_at: null,
    uses: 0
  }
}

describe('INTEGRATION_ALTERS', () => {
  it('is idempotent: applying it twice never throws (duplicate column name is expected and skipped by migrate.mjs, but the statements themselves must be plain ALTER/ADD COLUMN, not something that fails outright)', () => {
    const db = new DatabaseSync(':memory:')
    const schema = readFileSync(join(__dirname, '..', '..', 'schema.sql'), 'utf8')
    db.exec(schema)
    for (const stmt of INTEGRATION_ALTERS) db.exec(stmt)
    for (const stmt of INTEGRATION_ALTERS) {
      expect(() => db.exec(stmt)).toThrow(/duplicate column name/i)
    }
  })

  it('adds a column for every field in IntegrationExtraColumns', () => {
    const db = freshDb()
    const columns = db.prepare('PRAGMA table_info(integrations)').all().map((c) => (c as { name: string }).name)
    for (const col of ['auth_kind', 'header_name', 'transport', 'mode', 'allow_writes', 'config_json', 'tools_json', 'last_test_json', 'last_test_at', 'notes']) {
      expect(columns).toContain(col)
    }
  })
})

describe('readIntegrationExtra', () => {
  it('returns INTEGRATION_EXTRA_DEFAULTS for a null/undefined row', () => {
    expect(readIntegrationExtra(null)).toEqual(INTEGRATION_EXTRA_DEFAULTS)
    expect(readIntegrationExtra(undefined)).toEqual(INTEGRATION_EXTRA_DEFAULTS)
  })

  it('defaults mode to brokered and allow_writes to 0 when absent (a row that predates the migration)', () => {
    const extra = readIntegrationExtra({ id: 'int-1', kind: 'hubspot' })
    expect(extra.mode).toBe('brokered')
    expect(extra.allow_writes).toBe(0)
  })

  it('reads a direct mode and a truthy allow_writes off the row', () => {
    const extra = readIntegrationExtra({ mode: 'direct', allow_writes: 1 })
    expect(extra.mode).toBe('direct')
    expect(extra.allow_writes).toBe(1)
  })

  it('never lets a malformed config_json escape as anything other than "{}"', () => {
    expect(readIntegrationExtra({ config_json: 'not json' }).config_json).toBe('{}')
    expect(readIntegrationExtra({ config_json: '[1,2,3]' }).config_json).toBe('{}')
    expect(readIntegrationExtra({ config_json: '{"a":"b"}' }).config_json).toBe('{"a":"b"}')
  })
})

describe('withIntegrationExtra', () => {
  it('merges a patch onto defaults, keeping everything the patch does not mention at its default', () => {
    const row = withIntegrationExtra({ id: 'int-1' }, { mode: 'direct' })
    expect(row.mode).toBe('direct')
    expect(row.allow_writes).toBe(0)
    expect(row.id).toBe('int-1')
  })

  it('preserves an existing extra value the patch does not touch', () => {
    const withNotes = withIntegrationExtra({ id: 'int-1' }, { notes: 'from support' })
    const withMode = withIntegrationExtra(withNotes, { mode: 'direct' })
    expect(withMode.notes).toBe('from support')
    expect(withMode.mode).toBe('direct')
  })
})

describe('writeIntegrationExtraColumns / readIntegrationExtraColumns (real SQLite)', () => {
  it('round-trips every field', async () => {
    const db = sqliteD1(freshDb())
    const store = d1Store(db)
    await store.putIntegration(baseRow('int-1'))

    const extra: IntegrationExtraColumns = {
      auth_kind: 'bearer',
      header_name: 'X-Api-Key',
      transport: 'rest',
      mode: 'direct',
      allow_writes: 1,
      config_json: JSON.stringify({ subdomain: 'acme' }),
      tools_json: JSON.stringify([{ name: 'list_contacts', write: false }]),
      last_test_json: JSON.stringify({ ok: true, latencyMs: 12, summary: 'Reached HubSpot' }),
      last_test_at: 5000,
      notes: 'primary workspace'
    }
    await writeIntegrationExtraColumns(db, 'int-1', extra)

    expect(await readIntegrationExtraColumns(db, 'int-1')).toEqual(extra)
  })

  it('reads null for a row that does not exist', async () => {
    const db = sqliteD1(freshDb())
    expect(await readIntegrationExtraColumns(db, 'missing')).toBeNull()
  })

  it('a plain store.putIntegration() (the narrower INSERT OR REPLACE in d1.ts) resets the extra columns to their SQL defaults, which is exactly why routes/integrations.ts always calls writeIntegrationExtraColumns immediately after', async () => {
    const db = sqliteD1(freshDb())
    const store = d1Store(db)
    await store.putIntegration(baseRow('int-1'))
    await writeIntegrationExtraColumns(db, 'int-1', {
      auth_kind: 'bearer',
      header_name: null,
      transport: 'rest',
      mode: 'direct',
      allow_writes: 1,
      config_json: '{}',
      tools_json: null,
      last_test_json: null,
      last_test_at: null,
      notes: 'kept until the next putIntegration'
    })

    // Simulate a rotate: the route re-reads the row, spreads it into a patch, and calls putIntegration
    // again - the same INSERT OR REPLACE that dropped these columns the first time this task's data.ts
    // module didn't exist.
    await store.putIntegration({ ...baseRow('int-1'), last4: 'wxyz' })
    const reset = await readIntegrationExtraColumns(db, 'int-1')
    expect(reset?.mode).toBe('brokered')
    expect(reset?.notes).toBeNull()

    // Reapplying (what the route actually does) restores it.
    await writeIntegrationExtraColumns(db, 'int-1', {
      auth_kind: 'bearer',
      header_name: null,
      transport: 'rest',
      mode: 'direct',
      allow_writes: 1,
      config_json: '{}',
      tools_json: null,
      last_test_json: null,
      last_test_at: null,
      notes: 'kept until the next putIntegration'
    })
    const reapplied = await readIntegrationExtraColumns(db, 'int-1')
    expect(reapplied?.mode).toBe('direct')
    expect(reapplied?.notes).toBe('kept until the next putIntegration')
  })
})

describe('deleteIntegrationRow', () => {
  it('removes the integration row and its grants', async () => {
    const raw = freshDb()
    const db = sqliteD1(raw)
    const store = d1Store(db)
    await store.putIntegration(baseRow('int-1'))
    await store.insertIntegrationGrant({ id: 'grant-1', integration_id: 'int-1', device_id: 'dev-a', ts: 1000 })

    await deleteIntegrationRow(db, 'int-1')

    expect(await store.getIntegration('int-1')).toBeNull()
    expect(await store.listIntegrationGrants('int-1', 10)).toEqual([])
  })

  it('is a no-op for an id that does not exist', async () => {
    const db = sqliteD1(freshDb())
    await expect(deleteIntegrationRow(db, 'missing')).resolves.toBeUndefined()
  })
})
