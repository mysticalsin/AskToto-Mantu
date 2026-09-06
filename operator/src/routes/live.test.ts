import { describe, expect, it } from 'vitest'
import { handleRequest, type Env } from '../index'
import { memoryStore, type SeatRow } from '../store'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY } from '../test-fixtures'

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
    first_seen: NOW,
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

describe('GET /v1/admin/live.json', () => {
  it('304s on a repeated If-None-Match, then 200s with a new ETag once the generation changes', async () => {
    const store = memoryStore()
    const first = await handleRequest(
      new Request('https://operator.test/v1/admin/live.json'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    expect(first.status).toBe(200)
    const etag = first.headers.get('etag')
    expect(etag).toBeTruthy()
    expect(first.headers.get('cache-control')).toBe('no-store')
    const body1 = (await first.json()) as { ok: boolean; serverNow: number }
    expect(body1.ok).toBe(true)
    expect(body1.serverNow).toBe(NOW)

    const second = await handleRequest(
      new Request('https://operator.test/v1/admin/live.json', { headers: { 'if-none-match': etag! } }),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    expect(second.status).toBe(304)
    expect(await second.text()).toBe('')

    // A heartbeat (any store mutation) changes buildLiveSnapshot's generation hash.
    await store.upsertSeat(seat({ device_id: 'dev-a' }))

    const third = await handleRequest(
      new Request('https://operator.test/v1/admin/live.json', { headers: { 'if-none-match': etag! } }),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    expect(third.status).toBe(200)
    expect(third.headers.get('etag')).not.toBe(etag)
  })
})

describe('GET /v1/admin/realtime/live-seats.json', () => {
  it('lists seats with a heartbeat in the last 30 min, with tier, licenseState and session fields', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'dev-a' }))
    await store.touchSession('dev-a', NOW - 30_000, 'heartbeat', { country: 'CA', city: 'Longueuil' }, { os: 'darwin', app_version: '1.8.5' })
    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/realtime/live-seats.json'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      rows: { deviceId: string; tier: string | null; licenseState: string; live: boolean; hostname: string | null }[]
    }
    expect(body.rows).toHaveLength(1)
    expect(body.rows[0]).toMatchObject({ deviceId: 'dev-a', tier: 'metis', licenseState: 'licensed', live: true, hostname: 'Tonys-MacBook-Pro' })
  })

  it('excludes a seat whose last heartbeat is outside the 30 min window', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'dev-old', last_seen: NOW - 60 * 60 * 1000 }))
    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/realtime/live-seats.json'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    const body = (await res.json()) as { rows: unknown[] }
    expect(body.rows).toEqual([])
  })
})

describe('GET /v1/admin/realtime/geo.json', () => {
  it('groups seats/sessions/events by country + city with bounded 30-min and 2-min windows', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'dev-a' }))
    await store.touchSession('dev-a', NOW - 30_000, 'heartbeat', { country: 'CA', city: 'Longueuil' }, { os: 'darwin', app_version: '1.8.5' })
    await store.insertEvent({ id: 'e1', ts: NOW - 30_000, kind: 'heartbeat', actor: null, device_id: 'dev-a', country: 'CA', detail: null })
    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/realtime/geo.json'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { rows: { country: string; city: string | null; events: number; liveSessions: number; seats30m: number }[] }
    expect(body.rows).toHaveLength(1)
    expect(body.rows[0]).toMatchObject({ country: 'CA', city: 'Longueuil', events: 1, liveSessions: 1, seats30m: 1 })
  })
})

describe('GET /v1/admin/realtime.geo.json (legacy alias)', () => {
  it('keeps returning the original { geo, regions } shape', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'dev-a' }))
    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/realtime.geo.json'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; geo: unknown[]; regions: unknown[] }
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.geo)).toBe(true)
    expect(Array.isArray(body.regions)).toBe(true)
  })
})

function integrationRow(overrides: Partial<import('../store').IntegrationRow> & Pick<import('../store').IntegrationRow, 'id'>): import('../store').IntegrationRow {
  return {
    kind: 'hubspot',
    label: 'HubSpot',
    base_url: null,
    cipher: null,
    iv: null,
    last4: null,
    scope_json: '{}',
    status: 'active',
    created_at: NOW,
    created_by: 'tony.walteur@gmail.com',
    rotated_at: null,
    revoked_at: null,
    last_used_at: null,
    uses: 0,
    ...overrides
  }
}

function issuedLicense(overrides: Partial<import('../store').IssuedLicenseRow> & Pick<import('../store').IssuedLicenseRow, 'jti'>): import('../store').IssuedLicenseRow {
  return {
    last4: 'ab12',
    key_hash: 'hash',
    days: 30,
    iat: Math.floor(NOW / 1000),
    exp: Math.floor(NOW / 1000) + 30 * 24 * 60 * 60,
    revoked: 0,
    created_at: NOW,
    created_by: 'tony.walteur@gmail.com',
    ...overrides
  }
}

describe('GET /v1/admin/live.json (task B7 rail counters)', () => {
  it('counts pending-approval seats, expiring-soon licenses and failing connectors, and hashes settingsVersion into generation', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'dev-pending', approval: 'pending' }))
    await store.upsertSeat(seat({ device_id: 'dev-approved', approval: 'approved' }))
    await store.putIssuedLicense(issuedLicense({ jti: 'lic-soon', exp: Math.floor((NOW + 3 * 24 * 60 * 60 * 1000) / 1000) }))
    await store.putIssuedLicense(issuedLicense({ jti: 'lic-far', exp: Math.floor((NOW + 60 * 24 * 60 * 60 * 1000) / 1000) }))
    await store.putIssuedLicense(issuedLicense({ jti: 'lic-revoked', revoked: 1, exp: Math.floor((NOW + 3 * 24 * 60 * 60 * 1000) / 1000) }))
    await store.putIntegration({
      ...integrationRow({ id: 'int-failing', status: 'active' }),
      last_test_at: NOW,
      last_test_json: JSON.stringify({ ok: false })
    } as unknown as import('../store').IntegrationRow)
    await store.putIntegration({
      ...integrationRow({ id: 'int-ok', status: 'active' }),
      last_test_at: NOW,
      last_test_json: JSON.stringify({ ok: true })
    } as unknown as import('../store').IntegrationRow)

    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/live.json'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    const body = (await res.json()) as {
      pendingApprovals: number
      expiringLicenses7d: number
      failingConnectors: number
      settingsVersion: number
      generation: number
    }
    expect(body.pendingApprovals).toBe(1)
    expect(body.expiringLicenses7d).toBe(1)
    expect(body.failingConnectors).toBe(1)
    expect(body.settingsVersion).toBe(0)
  })

  it('unseenNotices counts every pending-seat notice when since is absent, and only newer ones when since is given', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'dev-a', approval: 'pending', last_seen: NOW - 1000 }))
    const all = await handleRequest(
      new Request('https://operator.test/v1/admin/live.json'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    const allBody = (await all.json()) as { unseenNotices: number }
    expect(allBody.unseenNotices).toBe(1)

    const filtered = await handleRequest(
      new Request(`https://operator.test/v1/admin/live.json?since=${NOW}`),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    const filteredBody = (await filtered.json()) as { unseenNotices: number }
    expect(filteredBody.unseenNotices).toBe(0)
  })
})

describe('GET /v1/admin/search.json', () => {
  it('finds a seat by hostname, a license by last4, a group by name and a connector by label, capped at 8 per group', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'dev-a', hostname: 'Tonys-MacBook-Pro' }))
    await store.putIssuedLicense(issuedLicense({ jti: 'lic-1', last4: 'zz99', tier: 'metis' }))
    await store.putGroup({ id: 'grp-1', name: 'Amaris team', tier: 'metis', notes: null, created_at: NOW, created_by: 'tony.walteur@gmail.com' })
    await store.putIntegration(integrationRow({ id: 'int-1', kind: 'hubspot', label: 'HubSpot production' }))

    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/search.json?q=tony'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    const body = (await res.json()) as {
      seats: { id: string; label: string; page: string }[]
      licenses: unknown[]
      groups: unknown[]
      integrations: unknown[]
    }
    expect(body.seats).toEqual([
      { id: 'dev-a', label: 'Tonys-MacBook-Pro', sublabel: 'twalteur@amaris.com', page: 'sessions', rowKey: 'dev-a' }
    ])

    const byLast4 = await handleRequest(
      new Request('https://operator.test/v1/admin/search.json?q=zz99'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    const byLast4Body = (await byLast4.json()) as { licenses: { id: string }[] }
    expect(byLast4Body.licenses).toEqual([{ id: 'lic-1', label: 'License ···zz99', sublabel: 'metis · active', page: 'licenses', rowKey: 'lic-1' }])

    const byGroup = await handleRequest(
      new Request('https://operator.test/v1/admin/search.json?q=amaris'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    const byGroupBody = (await byGroup.json()) as { groups: { id: string }[] }
    expect(byGroupBody.groups).toEqual([{ id: 'grp-1', label: 'Amaris team', sublabel: 'metis', page: 'groups', rowKey: 'grp-1' }])

    const byConnector = await handleRequest(
      new Request('https://operator.test/v1/admin/search.json?q=hubspot'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    const byConnectorBody = (await byConnector.json()) as { integrations: { id: string }[] }
    expect(byConnectorBody.integrations).toEqual([{ id: 'int-1', label: 'HubSpot production', sublabel: 'hubspot', page: 'connectors', rowKey: 'int-1' }])
  })

  it('returns every group empty for a blank query', async () => {
    const store = memoryStore()
    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/search.json'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    const body = (await res.json()) as { seats: unknown[]; licenses: unknown[]; groups: unknown[]; integrations: unknown[] }
    expect(body).toEqual({ ok: true, seats: [], licenses: [], groups: [], integrations: [] })
  })
})
