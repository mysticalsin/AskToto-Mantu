import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker, { handleRequest, type Env } from './index'
import { EXPECTED_D1_COLUMNS } from './routes/admin-core'
import { migratedDb, sqliteD1 } from './test-d1'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY } from './test-fixtures'
import { parseStatements } from '../scripts/migrate.mjs'

function env(overrides: Partial<Env> = {}): Env {
  return {
    OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET,
    OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY,
    OPERATOR_SKILL_PRIVATE_KEY: 'unused',
    ...overrides
  }
}

interface Health {
  ok: boolean
  d1: string
  schema: string | string[]
}

async function health(e: Env): Promise<{ status: number; body: Health }> {
  const res = await handleRequest(new Request('https://operator.test/health'), e, {})
  return { status: res.status, body: (await res.json()) as Health }
}

afterEach(() => vi.restoreAllMocks())

describe.each([undefined, 'production', 'staging', 'test', 'dev'])('Worker without a D1 binding (OPERATOR_ENV=%s)', (operatorEnv) => {
  const unbound = env({ OPERATOR_ENV: operatorEnv })

  it('refuses every non-health route with 503 instead of serving an ephemeral store', async () => {
    for (const path of ['/', '/v1/ingest', '/v1/admin/health.json', '/v1/skills/manifest']) {
      const res = await handleRequest(new Request(`https://operator.test${path}`), unbound, {})
      expect(res.status, path).toBe(503)
    }
  })

  it('reports /health ok:false with d1 unbound', async () => {
    const { status, body } = await health(unbound)
    expect(status).toBe(503)
    expect(body.ok).toBe(false)
    expect(body.d1).toBe('unbound')
  })

  it('exits the cron without pruning anything', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await worker.scheduled({}, unbound, {})
    expect(log).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledTimes(1)
  })
})

describe('/health readiness against a bound D1', () => {
  it('is live (200, ok) only at the migration head', async () => {
    const { status, body } = await health(env({ DB: sqliteD1(migratedDb()) }))
    expect(status).toBe(200)
    expect(body).toMatchObject({ ok: true, d1: 'ok', schema: 'ok' })
  })

  it('is degraded when a table from the migration head is missing', async () => {
    const db = migratedDb()
    db.exec('DROP TABLE operator_settings')
    const { status, body } = await health(env({ DB: sqliteD1(db) }))
    expect(status).toBe(503)
    expect(body.ok).toBe(false)
    expect(body.schema).toEqual(['operator_settings'])
  })

  it('is degraded when schema-alter.sql was never applied', async () => {
    const db = new DatabaseSync(':memory:')
    db.exec(readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8'))
    db.exec('ALTER TABLE seats DROP COLUMN license_jti')
    const { status, body } = await health(env({ DB: sqliteD1(db) }))
    expect(status).toBe(503)
    expect(body.ok).toBe(false)
    expect(body.schema).toContain('seats.license_jti')
  })

  it('is degraded when D1 itself fails', async () => {
    const broken = sqliteD1(migratedDb())
    const failing = {
      ...broken,
      prepare: () => {
        throw new Error('D1 down')
      }
    }
    const { status, body } = await health(env({ DB: failing }))
    expect(status).toBe(503)
    expect(body.ok).toBe(false)
  })
})

describe('EXPECTED_D1_COLUMNS', () => {
  it('covers every column schema-alter.sql adds', () => {
    const sql = readFileSync(join(__dirname, '..', 'schema-alter.sql'), 'utf8')
    for (const stmt of parseStatements(sql)) {
      const m = /^ALTER TABLE (\w+) ADD COLUMN (\w+)/i.exec(stmt)
      if (m) expect(EXPECTED_D1_COLUMNS[m[1]], `${m[1]}.${m[2]}`).toContain(m[2])
    }
  })
})
