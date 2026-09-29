import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { D1DatabaseLike } from './d1'
import { parseStatements } from '../scripts/migrate.mjs'

/** Real SQLite underneath (node:sqlite, unflagged on Node 22), so tests exercise the actual SQL d1.ts
 *  sends: dynamic WHERE/JOIN, keyset cursors, ON CONFLICT. */
export function sqliteD1(db: DatabaseSync): D1DatabaseLike {
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
          const result = stmt.run(...(bound as never[]))
          return { success: true, meta: { changes: Number(result.changes) } }
        }
      }
      return wrapper
    },
    async batch(statements) {
      db.exec('BEGIN')
      try {
        const results = []
        for (const statement of statements) results.push(await statement.run() as { success: boolean })
        db.exec('COMMIT')
        return results
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }
  }
}

const OPERATOR_ROOT = join(__dirname, '..')

/** An in-memory SQLite at the migration head: `schema.sql`, then `schema-alter.sql` the way
 *  `migrate.mjs` applies it (one statement at a time, "duplicate column" / "already exists" skipped). */
export function migratedDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(readFileSync(join(OPERATOR_ROOT, 'schema.sql'), 'utf8'))
  for (const stmt of parseStatements(readFileSync(join(OPERATOR_ROOT, 'schema-alter.sql'), 'utf8'))) {
    try {
      db.exec(stmt)
    } catch (error) {
      if (!/duplicate column name|already exists/i.test(String(error))) throw error
    }
  }
  return db
}
