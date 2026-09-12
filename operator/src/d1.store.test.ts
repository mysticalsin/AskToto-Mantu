import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { d1Store, type D1DatabaseLike } from './d1'
import { memoryStore } from './store'
import type {
  AskRow,
  GroupMemberRow,
  GroupRow,
  IntegrationGrantRow,
  IntegrationRow,
  IssuedLicenseRow,
  SeatRow,
  TierRow
} from './store'

/** Real SQLite underneath (node:sqlite, unflagged on Node 22), schema.sql applied verbatim, so these
 *  tests exercise the actual SQL d1.ts sends: dynamic WHERE/JOIN, keyset cursors, ON CONFLICT. */
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
          const result = stmt.run(...(bound as never[]))
          return { success: true, meta: { changes: Number(result.changes) } }
        }
      }
      return wrapper
    }
  }
}

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  const schema = readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8')
  db.exec(schema)
  return db
}

function seat(overrides: Partial<SeatRow> & Pick<SeatRow, 'device_id'>): SeatRow {
  return {
    seat_hash: 'seat',
    os: 'darwin',
    app_version: '1.8.5',
    first_seen: 1000,
    last_seen: 1000,
    country: 'CA',
    city: 'Longueuil',
    region: 'Quebec',
    lat: 45.5,
    lon: -73.5,
    last_index_at: null,
    hostname: 'Tonys-MacBook-Pro',
    sso_email: 'twalteur@amaris.com',
    license: 'licensed',
    approval: 'approved',
    license_jti: null,
    ...overrides
  }
}

function ask(overrides: Partial<AskRow> & Pick<AskRow, 'id'>): AskRow {
  return {
    device_id: 'dev-a',
    ts: 1000,
    mode: 'answer',
    skill_id: null,
    skill_version: null,
    provider: 'anthropic',
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
    question_type: null,
    ...overrides
  }
}

let db: DatabaseSync
let store: ReturnType<typeof d1Store>

beforeEach(() => {
  db = freshDb()
  store = d1Store(sqliteD1(db))
})

describe('getSeat', () => {
  it('returns the seat by device id, or null', async () => {
    await store.upsertSeat(seat({ device_id: 'dev-a' }))
    expect((await store.getSeat('dev-a'))?.hostname).toBe('Tonys-MacBook-Pro')
    expect(await store.getSeat('missing')).toBeNull()
  })

  it('does not let a later unlicensed heartbeat wipe a jti-backed licensed label', async () => {
    await store.upsertSeat(
      seat({
        device_id: 'baa2dc6edd670a9894ed402b5a9b9246',
        hostname: 'Totos-Mac.local',
        license: 'licensed · ZRl4',
        approval: 'pending',
        license_jti: '626f3683991c12c6'
      })
    )
    await store.upsertSeat(
      seat({
        device_id: 'baa2dc6edd670a9894ed402b5a9b9246',
        hostname: 'Totos-Mac.local',
        license: 'unlicensed',
        approval: 'pending',
        license_jti: null
      })
    )
    const row = await store.getSeat('baa2dc6edd670a9894ed402b5a9b9246')
    expect(row?.license).toBe('licensed · ZRl4')
    expect(row?.license_jti).toBe('626f3683991c12c6')
  })
})

describe('listAsks with since', () => {
  it('filters by ts when since is given, otherwise returns everything up to limit', async () => {
    await store.insertAsk(ask({ id: 'old', ts: 1000 }))
    await store.insertAsk(ask({ id: 'new', ts: 5000 }))
    expect((await store.listAsks(10)).map((a) => a.id).sort()).toEqual(['new', 'old'])
    expect((await store.listAsks(10, 4000)).map((a) => a.id)).toEqual(['new'])
  })
})

describe('listEvents overload', () => {
  beforeEach(async () => {
    await store.upsertSeat(seat({ device_id: 'dev-a', os: 'darwin', app_version: '1.8.5' }))
    await store.upsertSeat(seat({ device_id: 'dev-b', os: 'windows', app_version: '1.8.4', country: 'US', city: 'Austin', hostname: 'win-box' }))
    await store.insertEvent({ id: 'e1', ts: 1000, kind: 'heartbeat', actor: null, device_id: 'dev-a', country: 'CA', detail: 'x' })
    await store.insertEvent({ id: 'e2', ts: 2000, kind: 'ask', actor: null, device_id: 'dev-a', country: 'CA', detail: 'y' })
    await store.insertEvent({ id: 'e3', ts: 3000, kind: 'heartbeat', actor: null, device_id: 'dev-b', country: 'US', detail: 'z' })
  })

  it('the bare-limit overload still returns a plain array', async () => {
    const rows = await store.listEvents(10)
    expect(rows).toHaveLength(3)
    expect(rows[0].id).toBe('e3')
  })

  it('filters by kind, os (joined from seats), and country', async () => {
    const heartbeats = await store.listEvents(10, { kinds: ['heartbeat'] })
    expect(heartbeats.rows.map((r) => r.id).sort()).toEqual(['e1', 'e3'])
    const windowsOnly = await store.listEvents(10, { os: 'windows' })
    expect(windowsOnly.rows.map((r) => r.id)).toEqual(['e3'])
    const caOnly = await store.listEvents(10, { country: 'ca' })
    expect(caOnly.rows.map((r) => r.id).sort()).toEqual(['e1', 'e2'])
  })

  it('search q matches joined seat hostname', async () => {
    const found = await store.listEvents(10, { q: 'win-box' })
    expect(found.rows.map((r) => r.id)).toEqual(['e3'])
  })

  it('pages with a cursor, keyset on (ts, id) descending', async () => {
    const page1 = await store.listEvents(10, { limit: 2 })
    expect(page1.rows.map((r) => r.id)).toEqual(['e3', 'e2'])
    expect(page1.nextCursor).toBeTruthy()
    const page2 = await store.listEvents(10, { limit: 2, cursor: page1.nextCursor! })
    expect(page2.rows.map((r) => r.id)).toEqual(['e1'])
    expect(page2.nextCursor).toBeNull()
  })
})

describe.each(['memory', 'D1'] as const)('%s event-search privacy before pagination', (backend) => {
  it.each(['ask', 'crm', 'heartbeat'])('does not match hidden %s detail', async (kind) => {
    const subject = backend === 'memory' ? memoryStore() : store
    await subject.insertEvent({ id: 'private', ts: 3000, kind, actor: null, device_id: 'dev-a', country: 'CA', detail: 'private albatross acquisition' })
    const result = await subject.listEvents(1, { q: 'albatross', limit: 1 })
    expect(result.rows).toEqual([])
    expect(result.nextCursor).toBeNull()
    // An ordinary metadata search still locates the row, without consulting the hidden detail.
    expect((await subject.listEvents(10, { q: 'dev-a' })).rows.map((row) => row.id)).toEqual(['private'])
  })

  it('filters hidden detail before consuming page slots while retaining operational search', async () => {
    const subject = backend === 'memory' ? memoryStore() : store
    await subject.insertEvent({ id: 'private', ts: 3000, kind: 'ask', actor: null, device_id: 'dev-a', country: 'CA', detail: 'operations private acquisition' })
    await subject.insertEvent({ id: 'visible-new', ts: 2000, kind: 'use', actor: null, device_id: 'dev-b', country: 'US', detail: 'operations ready' })
    await subject.insertEvent({ id: 'visible-old', ts: 1000, kind: 'platform', actor: null, device_id: 'dev-b', country: 'US', detail: 'operations update' })
    const first = await subject.listEvents(1, { q: 'operations', limit: 1 })
    expect(first.rows.map((row) => row.id)).toEqual(['visible-new'])
    expect(first.nextCursor).toBeTruthy()
    const second = await subject.listEvents(1, { q: 'operations', limit: 1, cursor: first.nextCursor! })
    expect(second.rows.map((row) => row.id)).toEqual(['visible-old'])
    expect((await subject.listEvents(1, { q: 'operations', limit: 1, cursor: second.nextCursor! })).rows).toEqual([])
  })
})

describe('countEventsByKind', () => {
  it('groups by kind within the window', async () => {
    await store.insertEvent({ id: 'e1', ts: 1000, kind: 'heartbeat', actor: null, device_id: 'd', country: null, detail: null })
    await store.insertEvent({ id: 'e2', ts: 1500, kind: 'heartbeat', actor: null, device_id: 'd', country: null, detail: null })
    await store.insertEvent({ id: 'e3', ts: 1500, kind: 'ask', actor: null, device_id: 'd', country: null, detail: null })
    await store.insertEvent({ id: 'e4', ts: 9000, kind: 'ask', actor: null, device_id: 'd', country: null, detail: null })
    expect(await store.countEventsByKind(1000, 2000)).toEqual({ heartbeat: 2, ask: 1 })
  })
})

describe('sessions', () => {
  it('touchSession opens, continues, and closes+reopens per the 2-minute-gap rule', async () => {
    const geo = { country: 'CA', city: 'Longueuil' }
    const meta = { os: 'darwin', app_version: '1.8.5' }
    const s1 = await store.touchSession('dev-a', 0, 'heartbeat', geo, meta)
    const s2 = await store.touchSession('dev-a', 60_000, 'ask', geo, meta)
    expect(s2.id).toBe(s1.id)
    expect(s2.pulses).toBe(2)
    expect(s2.asks).toBe(1)
    const s3 = await store.touchSession('dev-a', 60_000 + 3 * 60_000, 'heartbeat', geo, meta)
    expect(s3.id).not.toBe(s1.id)
    const detail = await store.getSession(s1.id)
    expect(detail?.session.ended_at).toBe(60_000)
  })

  it('listSessions filters and pages, closeStaleSessions closes what is past the gap', async () => {
    const geo = { country: 'CA', city: 'Longueuil' }
    const meta = { os: 'darwin', app_version: '1.8.5' }
    await store.touchSession('dev-a', 0, 'heartbeat', geo, meta)
    await store.touchSession('dev-b', 0, 'heartbeat', geo, meta)
    const page = await store.listSessions({ deviceId: 'dev-a', limit: 10 })
    expect(page.rows).toHaveLength(1)
    expect(page.rows[0].device_id).toBe('dev-a')
    const closed = await store.closeStaleSessions(10 * 60_000)
    expect(closed).toBe(2)
  })
})

describe('groups, tiers, integrations', () => {
  it('CRUDs groups and members', async () => {
    const g: GroupRow = { id: 'g1', name: 'Amaris', tier: 'metis', notes: null, created_at: 1, created_by: 'tony' }
    await store.putGroup(g)
    expect(await store.getGroup('g1')).toMatchObject({ name: 'Amaris' })
    const member: GroupMemberRow = { group_id: 'g1', member: 'a@amaris.com', kind: 'email', added_at: 1, added_by: 'tony' }
    await store.putGroupMember(member)
    expect(await store.listGroupMembers('g1')).toHaveLength(1)
    await store.deleteGroupMember('g1', 'a@amaris.com')
    expect(await store.listGroupMembers('g1')).toHaveLength(0)
    await store.deleteGroup('g1')
    expect(await store.getGroup('g1')).toBeNull()
  })

  it('CRUDs tiers, defaulting to none until seeded', async () => {
    expect(await store.listTiers()).toEqual([])
    const tier: TierRow = { id: 'metis', label: 'Métis', entitlements_json: '["ask"]', updated_at: 1 }
    await store.putTier(tier)
    expect(await store.listTiers()).toEqual([tier])
  })

  it('CRUDs integrations, meta strips cipher/iv, grants and use counters work', async () => {
    const row: IntegrationRow = {
      id: 'int-1',
      kind: 'hubspot',
      label: 'Amaris HubSpot',
      base_url: 'https://api.hubapi.com',
      cipher: 'secret-cipher',
      iv: 'secret-iv',
      last4: 'abcd',
      scope_json: '{"groups":["g1"]}',
      status: 'active',
      created_at: 1,
      created_by: 'tony',
      rotated_at: null,
      revoked_at: null,
      last_used_at: null,
      uses: 0
    }
    await store.putIntegration(row)
    const meta = await store.listIntegrationsMeta()
    expect(meta).toHaveLength(1)
    expect(meta[0]).not.toHaveProperty('cipher')
    expect(meta[0]).not.toHaveProperty('iv')
    const grant: IntegrationGrantRow = { id: 'grant-1', integration_id: 'int-1', device_id: 'dev-a', ts: 5 }
    await store.insertIntegrationGrant(grant)
    expect(await store.listIntegrationGrants('int-1', 10)).toHaveLength(1)
    await store.bumpIntegrationUse('int-1', 100)
    const updated = await store.getIntegration('int-1')
    expect(updated?.uses).toBe(1)
    expect(updated?.last_used_at).toBe(100)
  })
})

describe('audit with request/route meta, listAudit filters', () => {
  it('stores and filters by actor/action/since', async () => {
    await store.audit('id-1', 1000, 'tony@x.com', 'reveal', 'ask-1', 'ask text', { requestId: 'ray-1', route: '/v1/admin/asks/ask-1' })
    await store.audit('id-2', 2000, 'other@x.com', 'reveal', null, 'x')
    const rows = await store.listAudit(10)
    expect(rows).toHaveLength(2)
    expect(rows[0].request_id).toBe(null) // most recent first: id-2 has no meta
    const filtered = await store.listAudit(10, { actor: 'tony@x.com' })
    expect(filtered).toHaveLength(1)
    expect(filtered[0].request_id).toBe('ray-1')
    expect(filtered[0].route).toBe('/v1/admin/asks/ask-1')
    expect(await store.listAudit(10, { since: 1500 })).toHaveLength(1)
  })
})

describe('vault supersede and clear', () => {
  it('supersedeActiveVaultKeys marks other active rows superseded and clears their secret', async () => {
    await store.putVaultKey({
      id: 'v1',
      provider: 'anthropic',
      label: 'old',
      last4: 'aaaa',
      cipher: 'c1',
      iv: 'i1',
      status: 'active',
      created_at: 1,
      created_by: 'tony',
      rotated_at: null,
      revoked_at: null
    })
    await store.putVaultKey({
      id: 'v2',
      provider: 'anthropic',
      label: 'new',
      last4: 'bbbb',
      cipher: 'c2',
      iv: 'i2',
      status: 'active',
      created_at: 2,
      created_by: 'tony',
      rotated_at: null,
      revoked_at: null
    })
    await store.supersedeActiveVaultKeys('anthropic', 'v2', 500)
    const v1 = await store.getVaultKey('v1')
    expect(v1?.status).toBe('superseded')
    expect(v1?.cipher).toBe('')
    expect(v1?.iv).toBe('')
    const v2 = await store.getVaultKey('v2')
    expect(v2?.status).toBe('active')
    expect(v2?.cipher).toBe('c2')
    await store.clearVaultSecret('v2')
    expect((await store.getVaultKey('v2'))?.cipher).toBe('')
  })
})

describe('issued license update/revoke and group fields', () => {
  it('putIssuedLicense round-trips group/tier/member, updateIssuedLicense patches, revoke sets revoked+activated_at', async () => {
    const lic: IssuedLicenseRow = {
      jti: 'j1',
      last4: 'zzzz',
      key_hash: 'hash',
      days: 30,
      iat: 1,
      exp: 999999,
      revoked: 0,
      created_at: 1,
      created_by: 'tony',
      group_id: 'g1',
      tier: 'metis',
      member: 'a@amaris.com',
      activated_device: null,
      activated_at: null
    }
    await store.putIssuedLicense(lic)
    expect(await store.getIssuedLicense('j1')).toMatchObject({ group_id: 'g1', tier: 'metis', member: 'a@amaris.com' })
    expect(await store.updateIssuedLicense('j1', { activated_device: 'dev-a', activated_at: 5 })).toBe(true)
    expect(await store.getIssuedLicense('j1')).toMatchObject({ activated_device: 'dev-a', activated_at: 5 })
    expect(await store.updateIssuedLicense('missing', { revoked: 1 })).toBe(false)
    expect(await store.revokeIssuedLicense('j1', 50)).toBe(true)
    const after = await store.getIssuedLicense('j1')
    expect(after?.revoked).toBe(1)
    expect(after?.activated_at).toBe(5) // does not clobber an already-set activation time
  })

  it('putIssuedLicense without group fields (legacy caller shape) still round-trips as null', async () => {
    await store.putIssuedLicense({
      jti: 'j2',
      last4: 'aaaa',
      key_hash: 'hash',
      days: 7,
      iat: 1,
      exp: 999999,
      revoked: 0,
      created_at: 1,
      created_by: 'tony'
    })
    expect(await store.getIssuedLicense('j2')).toMatchObject({ group_id: null, tier: null, member: null })
  })

  it('listIssuedLicenses respects an optional limit', async () => {
    for (let i = 0; i < 3; i++) {
      await store.putIssuedLicense({
        jti: `j-${i}`,
        last4: 'aaaa',
        key_hash: 'h',
        days: 1,
        iat: i,
        exp: 999999,
        revoked: 0,
        created_at: i,
        created_by: 'tony'
      })
    }
    expect(await store.listIssuedLicenses()).toHaveLength(3)
    expect(await store.listIssuedLicenses(2)).toHaveLength(2)
  })
})

describe.each(['memory', 'D1'] as const)('%s atomic licence binding', (backend) => {
  let subject: ReturnType<typeof memoryStore>
  const now = 1_725_000_000_000
  const jti = '1122334455667788'
  beforeEach(async () => {
    subject = backend === 'memory' ? memoryStore() : store
    await subject.putIssuedLicense({
      jti, last4: 'test', key_hash: 'verified-token-hash', days: 7,
      iat: now / 1000, exp: now / 1000 + 604_800, revoked: 0,
      created_at: now, created_by: 'test-operator'
    })
  })

  it('allows exactly one device to claim an unbound licence and permits that device to return', async () => {
    const results = await Promise.all([
      subject.bindIssuedLicense(jti, 'verified-token-hash', 'device-a', now),
      subject.bindIssuedLicense(jti, 'verified-token-hash', 'device-b', now)
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
    const winner = results[0] ? 'device-a' : 'device-b'
    expect(await subject.getIssuedLicense(jti)).toMatchObject({ activated_device: winner, activated_at: now })
    expect(await subject.bindIssuedLicense(jti, 'verified-token-hash', winner, now + 1_000)).toBe(true)
    expect((await subject.getIssuedLicense(jti))?.activated_at).toBe(now)
  })

  it.each(['revoked', 'expired', 'wrong-hash', 'seat-revoked'] as const)('refuses %s at the mutation itself', async (reason) => {
    if (reason === 'revoked') await subject.revokeIssuedLicense(jti, now)
    if (reason === 'expired') await subject.updateIssuedLicense(jti, { exp: now / 1000 })
    if (reason === 'seat-revoked') await subject.upsertSeat(seat({ device_id: 'device-a', approval: 'revoked' }))
    expect(await subject.bindIssuedLicense(
      jti, reason === 'wrong-hash' ? 'wrong-hash' : 'verified-token-hash', 'device-a', now
    )).toBe(false)
    expect((await subject.getIssuedLicense(jti))?.activated_device).toBeFalsy()
  })

  it('consumes a concurrent nonce exactly once', async () => {
    expect((await Promise.all([subject.takeNonce('one-request', now), subject.takeNonce('one-request', now)])).sort())
      .toEqual([false, true])
  })
})

describe('pruneTable', () => {
  it('deletes rows older than the cutoff, capped, across every retained table', async () => {
    await store.insertEvent({ id: 'e-old', ts: 1, kind: 'heartbeat', actor: null, device_id: 'd', country: null, detail: null })
    await store.insertEvent({ id: 'e-new', ts: 9000, kind: 'heartbeat', actor: null, device_id: 'd', country: null, detail: null })
    expect(await store.pruneTable('events', 100, 50)).toBe(1)
    expect((await store.listEvents(10)).map((e) => e.id)).toEqual(['e-new'])
  })
})

describe('listPacks / latestPacks omit the body', () => {
  it('never returns the pack body', async () => {
    await store.putPack({
      id: 'p1',
      skill_id: 'skill-a',
      version: '1',
      sha256: 'sha',
      body: 'a very large signed skill body that should not round-trip through the dashboard',
      signed: 'sig',
      pushed_at: 1,
      pushed_by: 'tony'
    })
    const rows = await store.listPacks()
    expect(rows).toHaveLength(1)
    expect(rows[0]).not.toHaveProperty('body')
    const latest = await store.latestPacks()
    expect(latest[0]).not.toHaveProperty('body')
  })
})
