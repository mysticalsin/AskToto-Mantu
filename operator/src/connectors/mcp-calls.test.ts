import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { D1DatabaseLike } from '../d1'
import { insertMcpCall, listMcpCalls, MCP_CALLS_TABLE_SQL, type McpCallRow } from './mcp-calls'

/** Same shim `d1.store.test.ts` and `connectors/data.test.ts` use: real SQLite underneath. */
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
          return (stmt.get(...(bound as never[])) as T) ?? null
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

/** `schema.sql` plus `MCP_CALLS_TABLE_SQL`, exactly as `migrate.mjs` would leave a real D1 after this
 *  task's migration runs - `schema.sql` itself is never edited for this table, only `schema-alter.sql`
 *  carries it, appended verbatim from this constant (see that file and `migrate.contract.test.ts`). */
function freshDb(): D1DatabaseLike {
  const db = new DatabaseSync(':memory:')
  const schema = readFileSync(join(__dirname, '..', '..', 'schema.sql'), 'utf8')
  db.exec(schema)
  for (const stmt of MCP_CALLS_TABLE_SQL) db.exec(stmt)
  return sqliteD1(db)
}

function row(overrides: Partial<McpCallRow> & Pick<McpCallRow, 'id'>): McpCallRow {
  return {
    ts: 1000,
    device_id: 'device-a',
    connection_id: 'conn-1',
    tool: 'list_contacts',
    ms: 42,
    outcome: 'ok',
    ...overrides
  }
}

describe('MCP_CALLS_TABLE_SQL', () => {
  it('is idempotent: creating the table and indexes twice never throws', () => {
    const db = new DatabaseSync(':memory:')
    const schema = readFileSync(join(__dirname, '..', '..', 'schema.sql'), 'utf8')
    db.exec(schema)
    for (const stmt of MCP_CALLS_TABLE_SQL) db.exec(stmt)
    expect(() => {
      for (const stmt of MCP_CALLS_TABLE_SQL) db.exec(stmt)
    }).not.toThrow()
  })
})

describe('insertMcpCall / listMcpCalls', () => {
  it('inserts a row with exactly device, connection, tool, ms and outcome - never an argument', async () => {
    const db = freshDb()
    await insertMcpCall(db, row({ id: 'call-1' }))
    const page = await listMcpCalls(db)
    expect(page.rows).toHaveLength(1)
    expect(page.rows[0]).toEqual(row({ id: 'call-1' }))
    expect(Object.keys(page.rows[0]).sort()).toEqual(['connection_id', 'device_id', 'id', 'ms', 'outcome', 'tool', 'ts'].sort())
  })

  it('lists newest first', async () => {
    const db = freshDb()
    await insertMcpCall(db, row({ id: 'call-1', ts: 1000 }))
    await insertMcpCall(db, row({ id: 'call-2', ts: 2000 }))
    await insertMcpCall(db, row({ id: 'call-3', ts: 1500 }))
    const page = await listMcpCalls(db)
    expect(page.rows.map((r) => r.id)).toEqual(['call-2', 'call-3', 'call-1'])
  })

  it('filters by deviceId and by connectionId', async () => {
    const db = freshDb()
    await insertMcpCall(db, row({ id: 'call-1', device_id: 'device-a', connection_id: 'conn-1' }))
    await insertMcpCall(db, row({ id: 'call-2', device_id: 'device-b', connection_id: 'conn-1' }))
    await insertMcpCall(db, row({ id: 'call-3', device_id: 'device-a', connection_id: 'conn-2' }))
    expect((await listMcpCalls(db, { deviceId: 'device-a' })).rows.map((r) => r.id).sort()).toEqual(['call-1', 'call-3'])
    expect((await listMcpCalls(db, { connectionId: 'conn-1' })).rows.map((r) => r.id).sort()).toEqual(['call-1', 'call-2'])
  })

  it('paginates with a cursor, newest first, no overlap and no gap', async () => {
    const db = freshDb()
    for (let i = 0; i < 5; i++) await insertMcpCall(db, row({ id: `call-${i}`, ts: 1000 + i }))
    const page1 = await listMcpCalls(db, { limit: 2 })
    expect(page1.rows.map((r) => r.id)).toEqual(['call-4', 'call-3'])
    expect(page1.nextCursor).toBeTruthy()
    const page2 = await listMcpCalls(db, { limit: 2, cursor: page1.nextCursor! })
    expect(page2.rows.map((r) => r.id)).toEqual(['call-2', 'call-1'])
    const page3 = await listMcpCalls(db, { limit: 2, cursor: page2.nextCursor! })
    expect(page3.rows.map((r) => r.id)).toEqual(['call-0'])
    expect(page3.nextCursor).toBeNull()
  })
})
