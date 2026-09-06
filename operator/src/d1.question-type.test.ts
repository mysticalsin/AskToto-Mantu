import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1Store, isMissingColumnError, resetD1SchemaProbeForTests, type D1DatabaseLike } from './d1'
import type { AskRow } from './store'

/**
 * Minimal D1 double: records every prepared statement and its bindings, and can be told to reject any
 * statement that names a column the "live" schema does not have. This is the migration-behind case.
 */
function fakeD1(opts: { columns: Set<string> }): { db: D1DatabaseLike; runs: { sql: string; args: unknown[] }[] } {
  const runs: { sql: string; args: unknown[] }[] = []
  const db: D1DatabaseLike = {
    prepare(sql: string) {
      let args: unknown[] = []
      const stmt = {
        bind(...values: unknown[]) {
          args = values
          return stmt
        },
        async first() {
          return null
        },
        async all() {
          return { results: [] }
        },
        async run() {
          const m = /INSERT OR REPLACE INTO asks \(([^)]+)\)/.exec(sql)
          if (m) {
            const cols = m[1].split(',').map((c) => c.trim())
            const missing = cols.find((c) => !opts.columns.has(c))
            if (missing) throw new Error(`D1_ERROR: table asks has no column named ${missing}: SQLITE_ERROR`)
            if (cols.length !== args.length) throw new Error(`bind count ${args.length} != columns ${cols.length}`)
          }
          runs.push({ sql, args })
          return {}
        }
      }
      return stmt
    }
  }
  return { db, runs }
}

const LEGACY_COLUMNS = new Set([
  'id', 'device_id', 'ts', 'mode', 'skill_id', 'skill_version', 'provider', 'model',
  'ttft_ms', 'total_ms', 'input_tokens', 'output_tokens', 'cache_read', 'cache_write',
  'cache_uncached', 'cache_status', 'cache_ttl', 'outcome', 'rating', 'prompt_cipher', 'prompt_iv', 'preview'
])
const MIGRATED_COLUMNS = new Set([...LEGACY_COLUMNS, 'question_type'])

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

describe('d1Store.insertAsk question_type fail-safe', () => {
  it('writes the type on a migrated D1', async () => {
    const { db, runs } = fakeD1({ columns: MIGRATED_COLUMNS })
    await d1Store(db).insertAsk(row())
    expect(runs).toHaveLength(1)
    expect(runs[0].sql).toContain('question_type')
    expect(runs[0].args.at(-1)).toBe('behavioral')
  })

  it('on a D1 that is one migration behind, stores the Ask without a type and warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { db, runs } = fakeD1({ columns: LEGACY_COLUMNS })
    const store = d1Store(db)
    await store.insertAsk(row({ id: 'first' }))
    await store.insertAsk(row({ id: 'second' }))
    expect(runs.map((r) => r.args[0])).toEqual(['first', 'second'])
    for (const r of runs) {
      expect(r.sql).not.toContain('question_type')
      expect(r.args).toHaveLength(22)
    }
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
