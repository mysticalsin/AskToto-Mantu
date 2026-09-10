import { describe, expect, it } from 'vitest'
import { memoryStore, type IntegrationRow, type IssuedLicenseRow, type SeatRow } from '../store'
import { exportTableDef, filtersFromSearchParams, isExportTable, type ExportRow } from './tables'

const NOW = 1_725_000_000_000

async function collectAll(gen: AsyncGenerator<ExportRow[]>): Promise<ExportRow[]> {
  const out: ExportRow[] = []
  for await (const batch of gen) out.push(...batch)
  return out
}

function seat(overrides: Partial<SeatRow> & Pick<SeatRow, 'device_id'>): SeatRow {
  return {
    seat_hash: 'h',
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
    license_jti: null,
    ...overrides
  }
}

function issued(overrides: Partial<IssuedLicenseRow> & Pick<IssuedLicenseRow, 'jti'>): IssuedLicenseRow {
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

function integration(overrides: Partial<IntegrationRow> & Pick<IntegrationRow, 'id'>): IntegrationRow {
  return {
    kind: 'hubspot',
    label: 'HubSpot',
    base_url: null,
    cipher: 'should-never-appear',
    iv: 'should-never-appear',
    last4: 'zz99',
    scope_json: '{}',
    status: 'active',
    created_at: NOW,
    created_by: 'tony.walteur@gmail.com',
    rotated_at: null,
    revoked_at: null,
    last_used_at: null,
    uses: 3,
    ...overrides
  }
}

describe('isExportTable', () => {
  it('accepts the seven exportable tables and rejects anything else', () => {
    for (const t of ['audit', 'events', 'sessions', 'asks', 'licenses', 'integrations', 'seats']) {
      expect(isExportTable(t)).toBe(true)
    }
    expect(isExportTable('vault_keys')).toBe(false)
    expect(isExportTable('')).toBe(false)
  })
})

describe('audit table', () => {
  it('projects the audited columns and applies since/actor/action/q', async () => {
    const store = memoryStore()
    await store.audit('a-1', NOW, 'tony.walteur@gmail.com', 'revoke-license', null, 'jti-1')
    await store.audit('a-2', NOW - 1000, 'system', 'platform.heartbeat', null, 'events 0')
    const rows = await collectAll(exportTableDef('audit').rows(store, { actor: 'tony.walteur@gmail.com' }))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actor: 'tony.walteur@gmail.com', action: 'revoke-license', detail: 'jti-1' })
  })
})

describe('asks table', () => {
  it('projects legacy Ask rows to classified metadata without stored preview or ciphertext', async () => {
    const store = memoryStore()
    await store.insertAsk({
      id: 'ask-1',
      device_id: 'dev-a',
      ts: NOW,
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
      cache_status: null,
      cache_ttl: null,
      outcome: 'ok',
      rating: null,
      prompt_cipher: 'top-secret-cipher',
      prompt_iv: 'top-secret-iv',
      preview: 'Customer Alpha private acquisition plan',
      question_type: 'how-to'
    })
    const rows = await collectAll(exportTableDef('asks').rows(store, {}))
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows[0])).not.toContain('top-secret')
    expect(rows[0].detail).toBe('answer ask · How to')
    expect(JSON.stringify(rows[0])).not.toContain('Customer Alpha')
  })
})

describe('licenses table', () => {
  it('carries last4 only, never a full license string, and derives status', async () => {
    const store = memoryStore()
    await store.putIssuedLicense(issued({ jti: 'lic-active' }))
    await store.putIssuedLicense(issued({ jti: 'lic-revoked', revoked: 1 }))
    const rows = await collectAll(exportTableDef('licenses').rows(store, { now: NOW }))
    expect(rows).toHaveLength(2)
    for (const r of rows) {
      expect(r).not.toHaveProperty('key_hash')
      expect(r.last4).toBe('ab12')
    }
    expect(rows.find((r) => r.jti === 'lic-active')?.status).toBe('active')
    expect(rows.find((r) => r.jti === 'lic-revoked')?.status).toBe('revoked')
  })

  it('filters by status', async () => {
    const store = memoryStore()
    await store.putIssuedLicense(issued({ jti: 'lic-active' }))
    await store.putIssuedLicense(issued({ jti: 'lic-revoked', revoked: 1 }))
    const rows = await collectAll(exportTableDef('licenses').rows(store, { status: 'revoked', now: NOW }))
    expect(rows.map((r) => r.jti)).toEqual(['lic-revoked'])
  })
})

describe('integrations table', () => {
  it('never carries cipher or iv', async () => {
    const store = memoryStore()
    await store.putIntegration(integration({ id: 'int-1' }))
    const rows = await collectAll(exportTableDef('integrations').rows(store, {}))
    expect(rows).toHaveLength(1)
    expect(rows[0]).not.toHaveProperty('cipher')
    expect(rows[0]).not.toHaveProperty('iv')
    expect(JSON.stringify(rows[0])).not.toContain('should-never-appear')
    expect(rows[0].last4).toBe('zz99')
  })
})

describe('seats table', () => {
  it('redacts a secret-shaped hostname/email and filters by country/os/status', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'dev-a', country: 'CA', os: 'darwin', approval: 'approved' }))
    await store.upsertSeat(seat({ device_id: 'dev-b', country: 'US', os: 'windows', approval: 'pending', hostname: null, sso_email: null }))
    const rows = await collectAll(exportTableDef('seats').rows(store, { country: 'CA' }))
    expect(rows).toHaveLength(1)
    expect(rows[0].device_id).toBe('dev-a')

    const pending = await collectAll(exportTableDef('seats').rows(store, { status: 'pending' }))
    expect(pending.map((r) => r.device_id)).toEqual(['dev-b'])
  })
})

describe('events and sessions tables (cursor-paginated store methods)', () => {
  it('events table yields rows across pages', async () => {
    const store = memoryStore()
    await store.insertEvent({ id: 'e1', ts: NOW, kind: 'heartbeat', actor: null, device_id: 'dev-a', country: 'CA', detail: 'x' })
    const rows = await collectAll(exportTableDef('events').rows(store, {}))
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('heartbeat')
  })

  it('events table suppresses legacy Ask, CRM, and heartbeat content details', async () => {
    const store = memoryStore()
    await store.insertEvent({ id: 'ask', ts: NOW, kind: 'ask', actor: null, device_id: 'dev-a', country: 'CA', detail: 'Customer Alpha private ask' })
    await store.insertEvent({ id: 'crm', ts: NOW - 1, kind: 'crm', actor: null, device_id: 'dev-a', country: 'CA', detail: 'Patient diagnosis CRM payload' })
    await store.insertEvent({ id: 'beat', ts: NOW - 2, kind: 'heartbeat', actor: null, device_id: 'dev-a', country: 'CA', detail: '/Users/tony/private.md' })
    const rows = await collectAll(exportTableDef('events').rows(store, {}))
    expect(rows).toHaveLength(3)
    expect(rows.map((row) => row.detail)).toEqual([null, null, null])
    expect(JSON.stringify(rows)).not.toContain('Customer Alpha')
    expect(JSON.stringify(rows)).not.toContain('Patient diagnosis')
    expect(JSON.stringify(rows)).not.toContain('/Users/tony')
  })

  it('sessions table computes duration_ms', async () => {
    const store = memoryStore()
    await store.touchSession('dev-a', NOW, 'heartbeat', { country: 'CA', city: 'Longueuil' }, { os: 'darwin', app_version: '1.8.5' })
    const rows = await collectAll(exportTableDef('sessions').rows(store, {}))
    expect(rows).toHaveLength(1)
    expect(rows[0].duration_ms).toBe(0)
  })
})

describe('filtersFromSearchParams', () => {
  it('parses since/until as numbers and kinds as a comma-split list', () => {
    const params = new URLSearchParams('since=100&until=200&kinds=ask,heartbeat&q=foo&country=ca')
    expect(filtersFromSearchParams(params)).toEqual({ since: 100, until: 200, kinds: ['ask', 'heartbeat'], q: 'foo', country: 'ca' })
  })
  it('omits absent filters entirely rather than including them as undefined', () => {
    expect(filtersFromSearchParams(new URLSearchParams(''))).toEqual({})
  })
})
