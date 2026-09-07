import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1Store, isMissingColumnError, resetD1SchemaProbeForTests, type D1DatabaseLike } from './d1'
import type { AskRow } from './store'

/** Thin adapter: node:sqlite's synchronous StatementSync wrapped to the async D1DatabaseLike shape
 *  d1.ts expects. Real SQLite underneath, so "no such column" is the engine's own error, not a mock's. */
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

function row(overrides: Partial<AskRow> = {}): AskRow {
  return {
    id: 'a1',
    device_id: 'dev',
    ts: 1,
    mode: 'interview',
    skill_id: null,
    skill_version: null,
    provider: null,
    model: null,
    ttft_ms: null,
    total_ms: null,
    input_tokens: null,
    output_tokens: null,
    cache_read: null,
    cache_write: null,
    cache_uncached: null,
    cache_status: null,
    cache_ttl: null,
    outcome: null,
    rating: null,
    prompt_cipher: null,
    prompt_iv: null,
    preview: null,
    question_type: 'behavioral',
    ...overrides
  }
}

const LEGACY_ASKS_TABLE = `CREATE TABLE asks (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL, ts INTEGER NOT NULL, mode TEXT, skill_id TEXT,
  skill_version TEXT, provider TEXT, model TEXT, ttft_ms INTEGER, total_ms INTEGER, input_tokens INTEGER,
  output_tokens INTEGER, cache_read INTEGER, cache_write INTEGER, cache_uncached INTEGER, cache_status TEXT,
  cache_ttl TEXT, outcome TEXT, rating TEXT, prompt_cipher TEXT, prompt_iv TEXT, preview TEXT
)`

const MIGRATED_ASKS_TABLE = `${LEGACY_ASKS_TABLE.slice(0, -1)}, question_type TEXT)`

beforeEach(() => resetD1SchemaProbeForTests())
afterEach(() => {
  resetD1SchemaProbeForTests()
  vi.restoreAllMocks()
})

describe('isMissingColumnError', () => {
  it('matches both SQLite phrasings for the named column only', () => {
    expect(isMissingColumnError(new Error('D1_ERROR: table asks has no column named question_type: SQLITE_ERROR'), 'question_type')).toBe(true)
    expect(isMissingColumnError(new Error('no such column: question_type'), 'question_type')).toBe(true)
    expect(isMissingColumnError(new Error('no such column: preview'), 'question_type')).toBe(false)
    expect(isMissingColumnError(new Error('UNIQUE constraint failed'), 'question_type')).toBe(false)
    expect(isMissingColumnError('string error has no column named question_type', 'question_type')).toBe(true)
  })
})

describe('d1Store.insertAsk question_type fail-safe (real SQLite underneath)', () => {
  it('writes the type on a migrated D1', async () => {
    const db = new DatabaseSync(':memory:')
    db.exec(MIGRATED_ASKS_TABLE)
    await d1Store(sqliteD1(db)).insertAsk(row())
    const written = db.prepare('SELECT * FROM asks WHERE id = ?').get('a1') as { question_type: string }
    expect(written.question_type).toBe('behavioral')
  })

  it('on a D1 that is one migration behind, stores the Ask without a type and warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = new DatabaseSync(':memory:')
    db.exec(LEGACY_ASKS_TABLE)
    const store = d1Store(sqliteD1(db))
    await store.insertAsk(row({ id: 'first' }))
    await store.insertAsk(row({ id: 'second' }))
    const rows = db.prepare('SELECT id FROM asks ORDER BY id').all() as { id: string }[]
    expect(rows.map((r) => r.id)).toEqual(['first', 'second'])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('schema-alter.sql')
  })

  it('any other D1 error still surfaces; the fallback is for the missing column only', async () => {
    const db: D1DatabaseLike = {
      prepare() {
        const stmt = {
          bind() {
            return stmt
          },
          async first() {
            return null
          },
          async all() {
            return { results: [] }
          },
          async run() {
            throw new Error('D1_ERROR: database is locked')
          }
        }
        return stmt
      }
    }
    await expect(d1Store(db).insertAsk(row())).rejects.toThrow(/locked/)
  })
})
