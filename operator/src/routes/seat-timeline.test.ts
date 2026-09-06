import { describe, expect, it } from 'vitest'
import { handleRequest, type Env } from '../index'
import { memoryStore, type IntegrationRow, type SeatRow } from '../store'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY } from '../test-fixtures'

const NOW = 1_725_000_000_000
const DAY = 24 * 60 * 60 * 1000

function env(): Env {
  return { OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET, OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY, OPERATOR_SKILL_PRIVATE_KEY: '' }
}

const tonyAccess = { getIdentity: async () => ({ email: 'tony.walteur@gmail.com' }) }

function seat(overrides: Partial<SeatRow> & Pick<SeatRow, 'device_id'>): SeatRow {
  return {
    seat_hash: 'seat',
    os: 'darwin',
    app_version: '1.8.5',
    first_seen: NOW - DAY,
    last_seen: NOW,
    country: 'CA',
    city: 'Longueuil',
    region: null,
    lat: null,
    lon: null,
    last_index_at: null,
    hostname: 'Tonys-MacBook-Pro',
    sso_email: 'twalteur@amaris.com',
    license: 'approved',
    approval: 'approved',
    ...overrides
  }
}

function integration(overrides: Partial<IntegrationRow> & Pick<IntegrationRow, 'id' | 'kind' | 'label'>): IntegrationRow {
  return {
    base_url: null,
    cipher: 'x',
    iv: 'y',
    last4: 'ab12',
    scope_json: '[]',
    status: 'connected',
    created_at: NOW - DAY,
    created_by: 'tony.walteur@gmail.com',
    rotated_at: null,
    revoked_at: null,
    last_used_at: null,
    uses: 0,
    ...overrides
  }
}

describe('GET /v1/admin/seats/:id/timeline.json', () => {
  it('merges heartbeats, asks (no text), events, CRM sends and connector grants, newest first', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'dev-a' }))
    await store.insertPulse({ id: 'p1', device_id: 'dev-a', ts: NOW - 5 * 60_000, kind: 'heartbeat', country: 'CA', city: 'Longueuil' })
    await store.insertAsk({
      id: 'ask-1',
      device_id: 'dev-a',
      ts: NOW - 4 * 60_000,
      mode: 'answer',
      skill_id: null,
      skill_version: null,
      provider: 'anthropic',
      model: 'claude',
      ttft_ms: null,
      total_ms: null,
      input_tokens: null,
      output_tokens: null,
      cache_read: null,
      cache_write: null,
      cache_uncached: null,
      cache_status: 'miss',
      cache_ttl: null,
      outcome: 'ok',
      rating: null,
      prompt_cipher: 'super-secret-ciphertext',
      prompt_iv: 'iv-value',
      preview: 'answer ask · Factual',
      question_type: 'factual'
    })
    await store.insertEvent({ id: 'ev-1', ts: NOW - 3 * 60_000, kind: 'license', actor: null, device_id: 'dev-a', country: 'CA', detail: 'approved' })
    await store.upsertCrm({
      id: 'crm-1',
      device_id: 'dev-a',
      ts: NOW - 2 * 60_000,
      status: 'success',
      title: 'Weekly sync',
      connector: 'hubspot',
      meeting_file: null,
      meeting_hash: null,
      last_error: null,
      retry_requested: 0,
      attempt: 1,
      latency_ms: 400,
      remote_id: 'rem-1',
      remote_url: null,
      action: null
    })
    await store.putIntegration(integration({ id: 'int-1', kind: 'hubspot', label: 'HubSpot' }))
    await store.insertIntegrationGrant({ id: 'grant-1', integration_id: 'int-1', device_id: 'dev-a', ts: NOW - 60_000 })

    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/seats/dev-a/timeline.json'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain('super-secret-ciphertext')
    expect(text).not.toContain('iv-value')
    expect(text.toLowerCase()).not.toContain('prompt_cipher')

    const body = JSON.parse(text) as {
      ok: boolean
      deviceId: string
      rows: { id: string; ts: number; kind: string }[]
      approval: string
      licenseState: string
      gatewayCallsAvailable: boolean
      nextCursor: string | null
    }
    expect(body.ok).toBe(true)
    expect(body.deviceId).toBe('dev-a')
    expect(body.rows.map((r) => r.kind)).toEqual(['grant', 'crm', 'event', 'ask', 'heartbeat'])
    expect(body.rows.map((r) => r.id)).toEqual(['grant-1', 'crm-1', 'ev-1', 'ask-1', 'p1'])
    // newest first: every row's ts is >= the next row's ts.
    for (let i = 1; i < body.rows.length; i++) expect(body.rows[i - 1].ts).toBeGreaterThanOrEqual(body.rows[i].ts)
    expect(body.approval).toBe('approved')
    expect(body.licenseState).toBe('approved')
    expect(body.gatewayCallsAvailable).toBe(false)
    expect(body.nextCursor).toBeNull()
  })

  it('never includes another device\'s rows', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'dev-a' }))
    await store.upsertSeat(seat({ device_id: 'dev-b', hostname: 'Other-Box' }))
    await store.insertPulse({ id: 'p-a', device_id: 'dev-a', ts: NOW - 60_000, kind: 'heartbeat', country: 'CA', city: null })
    await store.insertPulse({ id: 'p-b', device_id: 'dev-b', ts: NOW - 60_000, kind: 'heartbeat', country: 'CA', city: null })

    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/seats/dev-a/timeline.json'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    const body = (await res.json()) as { rows: { id: string }[] }
    expect(body.rows).toHaveLength(1)
    expect(body.rows[0].id).toBe('p-a')
  })

  it('paginates with a cursor, newest page first, no duplicate or dropped rows', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'dev-a' }))
    for (let i = 0; i < 5; i++) {
      await store.insertPulse({ id: `p${i}`, device_id: 'dev-a', ts: NOW - i * 60_000, kind: 'heartbeat', country: 'CA', city: null })
    }

    const first = await handleRequest(
      new Request('https://operator.test/v1/admin/seats/dev-a/timeline.json?limit=2'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    const firstBody = (await first.json()) as { rows: { id: string }[]; nextCursor: string | null }
    expect(firstBody.rows.map((r) => r.id)).toEqual(['p0', 'p1'])
    expect(firstBody.nextCursor).not.toBeNull()

    const second = await handleRequest(
      new Request(`https://operator.test/v1/admin/seats/dev-a/timeline.json?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor!)}`),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    const secondBody = (await second.json()) as { rows: { id: string }[] }
    expect(secondBody.rows.map((r) => r.id)).toEqual(['p2', 'p3'])
  })

  it('resolves the seat\'s group by device membership', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'dev-a' }))
    await store.putGroup({ id: 'grp-1', name: 'Ops team', tier: 'metis', notes: null, created_at: NOW - DAY, created_by: 'tony.walteur@gmail.com' })
    await store.putGroupMember({ group_id: 'grp-1', member: 'dev-a', kind: 'device', added_at: NOW - DAY, added_by: 'tony.walteur@gmail.com' })

    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/seats/dev-a/timeline.json'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    const body = (await res.json()) as { group: { id: string; name: string } | null }
    expect(body.group).toEqual({ id: 'grp-1', name: 'Ops team' })
  })

  it('404s for an unknown device', async () => {
    const store = memoryStore()
    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/seats/nope/timeline.json'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    expect(res.status).toBe(404)
  })
})
