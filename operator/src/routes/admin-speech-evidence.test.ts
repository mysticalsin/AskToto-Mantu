import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { parseStatements } from '../../scripts/migrate.mjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { D1DatabaseLike } from '../d1'
import { memoryStore } from '../store'
import { clearRoutes, matchRoute } from './registry'
import { registerAdminSpeechEvidenceRoutes } from './admin-speech-evidence'
import { TEST_OWNER_EMAIL, TEST_PROMPT_KEY } from '../test-fixtures'

function sqliteD1(db: DatabaseSync): D1DatabaseLike {
  return {
    prepare(sql) {
      const statement = db.prepare(sql)
      let values: unknown[] = []
      const wrapper = {
        bind(...args: unknown[]) {
          values = args
          return wrapper
        },
        async first<T>() {
          return (statement.get(...(values as never[])) as T) ?? null
        },
        async all<T>() {
          return { results: statement.all(...(values as never[])) as T[] }
        },
        async run() {
          const result = statement.run(...(values as never[]))
          return { success: true, meta: { changes: Number(result.changes) } }
        }
      }
      return wrapper
    }
  }
}

function routeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  const root = join(__dirname, '..', '..')
  db.exec(readFileSync(join(root, 'schema.sql'), 'utf8'))
  for (const statement of parseStatements(readFileSync(join(root, 'schema-alter.sql'), 'utf8'))) {
    try {
      db.exec(statement)
    } catch (error) {
      if (!/duplicate column name|already exists/i.test(String(error))) throw error
    }
  }
  return db
}

const now = 1_800_000_000_000
const env = {
  OPERATOR_INGEST_SECRET: 'synthetic-ingest',
  OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY,
  OPERATOR_SKILL_PRIVATE_KEY: '',
  ADMIN_EMAILS: `${TEST_OWNER_EMAIL},reviewer@example.test`,
  OWNER_EMAILS: `${TEST_OWNER_EMAIL},reviewer@example.test`,
  SPEECH_TENANT_ID: 'tenant-test',
  SPEECH_AUDIENCE: 'operator-test',
  SPEECH_DEPLOYMENT_ID: 'test-deployment',
  CF_ACCOUNT_ID: '00000000000000000000000000000000',
  SPEECH_GATEWAY_ID: 'speech-test',
  SPEECH_POLICY_VERSION: 'policy-v1',
  SPEECH_IMPLEMENTATION_REVISION: 'revision-1',
  SPEECH_CONFIG_VERSION: 'config-v1',
  SPEECH_ROUTE_ID: 'workers-ai-nova3',
  SPEECH_MODEL_ID: '@cf/deepgram/nova-3',
  SPEECH_GATEWAY_MANAGEMENT_TOKEN: 'synthetic-gateway-token'
}

function evidenceBody(expectedVersion: number) {
  return {
    expectedVersion,
    expiresAt: now + 60_000,
    reviewerEmail: 'reviewer@example.test',
    routeId: 'workers-ai-nova3',
    modelId: '@cf/deepgram/nova-3',
    configVersion: 'config-v1',
    references: [
      ['gateway-readback', 'gateway'],
      ['provider-retention', 'provider'],
      ['synthetic-sink-test', 'sink'],
      ['relay-runtime-test', 'relay']
    ].map(([kind, name]) => ({
      kind,
      reference: `https://evidence.example.test/${name}`,
      digest: `sha256:${'a'.repeat(64)}`,
      outcome: 'passed'
    }))
  }
}

describe('admin speech route evidence versioning', () => {
  it('supports insert, versioned replacement, stale CAS refusal, and revoke', async () => {
    clearRoutes()
    registerAdminSpeechEvidenceRoutes()
    const database = routeDb()
    const store = memoryStore()
    const db = sqliteD1(database)
    const cfFetch: typeof fetch = async () =>
      Response.json({
        success: true,
        result: {
          id: 'speech-test',
          collect_logs: false,
          cache_ttl: 0,
          logpush: false,
          otel: [],
          log_classification: false
        }
      })
    const ctx = {
      request: new Request('https://operator.test/v1/admin/speech/evidence'),
      url: new URL('https://operator.test/v1/admin/speech/evidence'),
      env: { ...env, DB: db },
      store,
      email: TEST_OWNER_EMAIL,
      now,
      opts: { cfFetch }
    }
    async function post(body: unknown, path = '/v1/admin/speech/evidence') {
      const request = new Request(`https://operator.test${path}`, { method: 'POST', body: JSON.stringify(body) })
      return matchRoute(request, { ...ctx, request, url: new URL(request.url) })
    }
    try {
      expect((await post(evidenceBody(9)))?.status).toBe(409)
      expect(database.prepare('SELECT COUNT(*) AS n FROM speech_route_evidence').get()).toMatchObject({ n: 0 })
      const inserted = await post(evidenceBody(0))
      expect(inserted?.status).toBe(200)
      const first = (await inserted!.json()) as { id: string; version: number }
      expect(first.version).toBe(1)
      expect((await post(evidenceBody(1)))?.status).toBe(200)
      expect((await post(evidenceBody(1)))?.status).toBe(409)
      const revoked = await post({ expectedVersion: 2 }, `/v1/admin/speech/evidence/${first.id}/revoke`)
      expect(revoked?.status).toBe(200)
      expect(await revoked!.json()).toMatchObject({ version: 3 })
      expect(
        database.prepare('SELECT version, revoked_at FROM speech_route_evidence WHERE id = ?').get(first.id)
      ).toMatchObject({ version: 3, revoked_at: now })
    } finally {
      database.close()
    }
  })
})
