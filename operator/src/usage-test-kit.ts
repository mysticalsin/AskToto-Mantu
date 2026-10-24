/** Test-only: a `node:sqlite` D1 shim (with `batch`) over the real schema files, for the G81 usage tests. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { D1DatabaseLike } from './d1'
import { USAGE_MIGRATIONS } from './usage-reconcile'

export function sqliteD1(db: DatabaseSync): D1DatabaseLike {
  function prepare(sql: string) {
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
  return {
    prepare,
    async batch(statements) {
      db.exec('BEGIN')
      try {
        const out: Array<{ success?: boolean }> = []
        for (const s of statements) {
          await (s as unknown as { run(): Promise<unknown> }).run()
          out.push({ success: true })
        }
        db.exec('COMMIT')
        return out
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }
  } as D1DatabaseLike
}

/** `asks` from the real schema.sql plus the usage table; `withUsage: false` leaves the usage table out. */
export function usageDb(opts: { withUsage?: boolean } = {}): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8'))
  if (opts.withUsage !== false) for (const stmt of USAGE_MIGRATIONS) db.exec(stmt)
  return db
}

export interface TestAsk {
  id: string
  device_id: string
  ts: number
  input_tokens: number | null
  output_tokens: number | null
  path_tag: string | null
  preview?: string | null
}

export function putAsk(db: DatabaseSync, a: TestAsk): void {
  db.prepare(
    `INSERT INTO asks (id, device_id, ts, input_tokens, output_tokens, path_tag, preview) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET device_id = excluded.device_id, ts = excluded.ts, input_tokens = excluded.input_tokens,
       output_tokens = excluded.output_tokens, path_tag = excluded.path_tag`
  ).run(a.id, a.device_id, a.ts, a.input_tokens, a.output_tokens, a.path_tag, a.preview ?? null)
}
