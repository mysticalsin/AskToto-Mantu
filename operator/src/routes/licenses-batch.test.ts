import { describe, expect, it } from 'vitest'
import { handleRequest, type Env } from '../index'
import { memoryStore, type SeatRow } from '../store'
import { verifyOperatorLicense } from '../../../src/shared/operator-license'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY } from '../test-fixtures'
import { BATCH_MAX } from '../licenses/batch'

const NOW = 1_725_000_000_000

function env(): Env {
  return { OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET, OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY, OPERATOR_SKILL_PRIVATE_KEY: '' }
}

const tonyAccess = { getIdentity: async () => ({ email: 'tony.walteur@gmail.com' }) }

function seat(overrides: Partial<SeatRow> & Pick<SeatRow, 'device_id'>): SeatRow {
  return {
    seat_hash: 'seat',
    os: 'darwin',
    app_version: '1.8.5',
    first_seen: NOW - 3_600_000,
    last_seen: NOW,
    country: 'CA',
    city: 'Montreal',
    region: null,
    lat: null,
    lon: null,
    last_index_at: null,
    hostname: 'mbp-known',
    sso_email: 'known@example.com',
    license: null,
    approval: 'approved',
    license_jti: null,
    ...overrides
  }
}

async function call(method: string, path: string, store: ReturnType<typeof memoryStore>, body?: unknown, headers: Record<string, string> = {}) {
  return handleRequest(
    new Request(`https://operator.test${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    }),
    env(),
    { access: tonyAccess },
    { store, now: NOW }
  )
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T
}

describe('unauthenticated', () => {
  it('401s POST /v1/admin/licenses/generate-batch without Access', async () => {
    const store = memoryStore()
    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/licenses/generate-batch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ count: 3, days: 30 })
      }),
      env(),
      {},
      { store, now: NOW }
    )
    expect(res.status).toBe(401)
  })
})

describe('CSRF', () => {
  it('refuses a cross-site POST with code csrf', async () => {
    const store = memoryStore()
    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/licenses/generate-batch', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
        body: JSON.stringify({ count: 3, days: 30 })
      }),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    expect(res.status).toBe(403)
    expect((await json(res)).code).toBe('csrf')
  })
})

describe('POST /v1/admin/licenses/generate-batch, count mode', () => {
  it('mints N licenses sharing one batch_id, writes N+1 audit rows, and every token verifies', async () => {
    const store = memoryStore()
    const res = await call('POST', '/v1/admin/licenses/generate-batch', store, { count: 5, days: 30 })
    expect(res.status).toBe(200)
    const body = await json<{ ok: boolean; batchId: string; count: number; licenses: { jti: string; license: string; last4: string }[] }>(res)
    expect(body.ok).toBe(true)
    expect(body.count).toBe(5)
    expect(body.licenses).toHaveLength(5)

    const jtis = new Set(body.licenses.map((l) => l.jti))
    expect(jtis.size).toBe(5)

    for (const lic of body.licenses) {
      const verified = await verifyOperatorLicense(TEST_INGEST_SECRET, lic.license, NOW)
      expect(verified.ok).toBe(true)
      const stored = await store.getIssuedLicense(lic.jti)
      expect(stored?.batch_id).toBe(body.batchId)
      expect(JSON.stringify(stored)).not.toContain(lic.license)
    }

    const audit = await store.listAudit(20)
    expect(audit).toHaveLength(6) // 5 per-license rows + 1 batch summary row
    expect(audit.filter((a) => a.action === 'license-generate-batch-item')).toHaveLength(5)
    const summary = audit.find((a) => a.action === 'license-generate-batch')
    expect(summary).toBeTruthy()
    expect(summary?.detail).toContain('5 licenses')
    expect(summary?.detail).toContain(body.batchId)
    expect(summary?.actor).toBe('tony.walteur@gmail.com')
  })

  it('caps a batch at 100 with code batch-too-large, minting nothing', async () => {
    const store = memoryStore()
    const res = await call('POST', '/v1/admin/licenses/generate-batch', store, { count: BATCH_MAX + 1, days: 30 })
    expect(res.status).toBe(400)
    const body = await json<{ code?: string }>(res)
    expect(body.code).toBe('batch-too-large')
    expect(await store.listIssuedLicenses()).toHaveLength(0)
    expect(await store.listAudit(10)).toHaveLength(0)
  })

  it('applies groupId and tier to every license in the batch', async () => {
    const store = memoryStore()
    await store.putGroup({ id: 'g1', name: 'Delivery', tier: 'metis', notes: null, created_at: NOW, created_by: 'tony.walteur@gmail.com' })
    const res = await call('POST', '/v1/admin/licenses/generate-batch', store, { count: 3, days: 90, groupId: 'g1' })
    expect(res.status).toBe(200)
    const body = await json<{ licenses: { tier: string | null; groupId: string | null }[] }>(res)
    for (const lic of body.licenses) {
      expect(lic.groupId).toBe('g1')
      expect(lic.tier).toBe('metis')
    }
  })

  it('rejects an unknown groupId before minting anything', async () => {
    const store = memoryStore()
    const res = await call('POST', '/v1/admin/licenses/generate-batch', store, { count: 3, days: 30, groupId: 'nope' })
    expect(res.status).toBe(400)
    expect(await store.listIssuedLicenses()).toHaveLength(0)
  })
})

describe('POST /v1/admin/licenses/generate-batch, members mode', () => {
  it('mints one license per line, bound to that member', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'dev-known-1' }))
    const res = await call('POST', '/v1/admin/licenses/generate-batch', store, {
      members: ['a@example.com', 'dev-known-1', 'B@Example.com'],
      days: 30
    })
    expect(res.status).toBe(200)
    const body = await json<{ licenses: { member: string | null }[] }>(res)
    expect(body.licenses.map((l) => l.member).sort()).toEqual(['a@example.com', 'b@example.com', 'dev-known-1'].sort())
  })

  it('returns every invalid or duplicate line before minting anything, never skipping silently', async () => {
    const store = memoryStore()
    const res = await call('POST', '/v1/admin/licenses/generate-batch', store, {
      members: ['a@example.com', 'not-an-email-or-device', 'a@example.com'],
      days: 30
    })
    expect(res.status).toBe(400)
    const body = await json<{ code?: string; invalid?: { line: string; error: string }[] }>(res)
    expect(body.code).toBe('invalid-members')
    expect(body.invalid).toHaveLength(2)
    expect(body.invalid?.some((i) => i.line === 'not-an-email-or-device')).toBe(true)
    expect(body.invalid?.some((i) => i.line === 'a@example.com' && i.error.includes('duplicate'))).toBe(true)
    expect(await store.listIssuedLicenses()).toHaveLength(0)
    expect(await store.listAudit(10)).toHaveLength(0)
  })

  it('caps a member-list batch at 100 lines', async () => {
    const store = memoryStore()
    const members = Array.from({ length: BATCH_MAX + 1 }, (_, i) => `member${i}@example.com`)
    const res = await call('POST', '/v1/admin/licenses/generate-batch', store, { members, days: 30 })
    expect(res.status).toBe(400)
    expect((await json<{ code?: string }>(res)).code).toBe('batch-too-large')
    expect(await store.listIssuedLicenses()).toHaveLength(0)
  })
})

describe('validation', () => {
  it('rejects a body with both count and members', async () => {
    const store = memoryStore()
    const res = await call('POST', '/v1/admin/licenses/generate-batch', store, { count: 2, members: ['a@example.com'], days: 30 })
    expect(res.status).toBe(400)
  })

  it('rejects a body with neither count nor members', async () => {
    const store = memoryStore()
    const res = await call('POST', '/v1/admin/licenses/generate-batch', store, { days: 30 })
    expect(res.status).toBe(400)
  })

  it('rejects an out-of-range days the same way the single route does', async () => {
    const store = memoryStore()
    const res = await call('POST', '/v1/admin/licenses/generate-batch', store, { count: 2, days: 999 })
    expect(res.status).toBe(400)
    expect(await store.listIssuedLicenses()).toHaveLength(0)
  })
})

describe('rate limit', () => {
  it('applies the shared admin mutation rate limit', async () => {
    const store = memoryStore()
    let last: Response | null = null
    for (let i = 0; i < 61; i++) {
      last = await call('POST', '/v1/admin/licenses/generate-batch', store, { count: 1, days: 30 })
    }
    expect(last?.status).toBe(429)
    expect((await json<{ code?: string }>(last!)).code).toBe('rate')
  })
})
