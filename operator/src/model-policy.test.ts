import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { D1DatabaseLike } from './d1'
import {
  MODEL_POLICY_MIGRATIONS,
  readModelPolicy,
  signModelPolicy,
  verifyModelPolicySignature,
  writeModelPolicy
} from './model-policy'
import { MODEL_POLICY_CAPABILITIES, type ModelPolicyDocument } from '../../src/shared/model-policy'

const NOW = 1_725_000_000_000
const SECRET = 'test-model-policy-secret'

/** Same node:sqlite D1 shim used by settings-store.test.ts / integrations-seat.test.ts. */
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

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  for (const stmt of MODEL_POLICY_MIGRATIONS) db.exec(stmt)
  return db
}

function capabilities(): Record<string, unknown> {
  return Object.fromEntries(
    MODEL_POLICY_CAPABILITIES.map((k) => [k, { provider: 'anthropic', model: 'claude-sonnet-4-6', fallbacks: [] }])
  )
}

describe('readModelPolicy / writeModelPolicy', () => {
  it('returns null (not managed) when no DB is bound', async () => {
    expect(await readModelPolicy(undefined)).toBeNull()
  })

  it('returns null on a migrated but empty table', async () => {
    expect(await readModelPolicy(sqliteD1(freshDb()))).toBeNull()
  })

  it('rejects capabilities missing a required key, writing nothing', async () => {
    const db = sqliteD1(freshDb())
    const { localModel: _drop, ...partial } = capabilities()
    void _drop
    const result = await writeModelPolicy(db, partial, 'owner@example.test', NOW)
    expect(result.ok).toBe(false)
    expect(await readModelPolicy(db)).toBeNull()
  })

  it('writes a valid document and reads it back with version/updatedAt/updatedBy stamped from the write', async () => {
    const db = sqliteD1(freshDb())
    const result = await writeModelPolicy(db, capabilities(), 'owner@example.test', NOW)
    expect(result.ok).toBe(true)
    const read = await readModelPolicy(db)
    expect(read?.version).toBe(NOW)
    expect(read?.updatedAt).toBe(NOW)
    expect(read?.updatedBy).toBe('owner@example.test')
    expect(read?.capabilities.askChat).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6', fallbacks: [] })
  })

  it('a second write replaces the whole document and bumps the version', async () => {
    const db = sqliteD1(freshDb())
    await writeModelPolicy(db, capabilities(), 'owner@example.test', NOW)
    const changed = { ...capabilities(), askChat: { provider: 'openai', model: 'gpt-5', fallbacks: [] } }
    const result = await writeModelPolicy(db, changed, 'owner@example.test', NOW + 1000)
    expect(result.ok).toBe(true)
    const read = await readModelPolicy(db)
    expect(read?.version).toBe(NOW + 1000)
    expect(read?.capabilities.askChat.provider).toBe('openai')
  })

  it('keeps every saved version in model_policy_history so an older policy can be read back', async () => {
    const raw = freshDb()
    const db = sqliteD1(raw)
    await writeModelPolicy(db, capabilities(), 'owner@example.test', NOW)
    await writeModelPolicy(db, { ...capabilities(), askChat: { provider: 'openai', model: 'gpt-5', fallbacks: [] } }, 'owner@example.test', NOW + 1000)
    const rows = raw.prepare('SELECT version, policy_json FROM model_policy_history ORDER BY version').all() as {
      version: number
      policy_json: string
    }[]
    expect(rows.map((r) => r.version)).toEqual([NOW, NOW + 1000])
    expect(JSON.parse(rows[0].policy_json).capabilities.askChat.provider).toBe('anthropic')
    expect(JSON.parse(rows[1].policy_json).capabilities.askChat.provider).toBe('openai')
  })
})

describe('signModelPolicy / verifyModelPolicySignature', () => {
  const doc: ModelPolicyDocument = {
    version: NOW,
    updatedAt: NOW,
    updatedBy: 'owner@example.test',
    capabilities: capabilities() as ModelPolicyDocument['capabilities']
  }

  it('a signature verifies against the exact document it was signed for', async () => {
    const signature = await signModelPolicy(SECRET, doc)
    expect(await verifyModelPolicySignature(SECRET, doc, signature)).toBe(true)
  })

  it('rejects a signature made with a different secret', async () => {
    const signature = await signModelPolicy('a-different-secret', doc)
    expect(await verifyModelPolicySignature(SECRET, doc, signature)).toBe(false)
  })

  it('rejects a tampered document (model changed after signing)', async () => {
    const signature = await signModelPolicy(SECRET, doc)
    const tampered: ModelPolicyDocument = {
      ...doc,
      capabilities: { ...doc.capabilities, askChat: { provider: 'openai', model: 'gpt-5', fallbacks: [] } }
    }
    expect(await verifyModelPolicySignature(SECRET, tampered, signature)).toBe(false)
  })

  it('rejects an empty or missing signature outright', async () => {
    expect(await verifyModelPolicySignature(SECRET, doc, '')).toBe(false)
  })
})
