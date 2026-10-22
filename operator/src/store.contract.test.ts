import { beforeEach, describe, expect, it } from 'vitest'
import { d1Store } from './d1'
import {
  memoryStore,
  type AskRow,
  type EnrollTokenRow,
  type EnrollmentRow,
  type IssuedLicenseRow,
  type OperatorStore,
  type SeatRow
} from './store'
import { migratedDb, sqliteD1 } from './test-d1'

/** One OperatorStore contract, run against every implementation: the in-memory store the tests inject and
 *  the D1 store the Worker serves from (real SQLite at the migration head). A behaviour one backend has and
 *  the other lacks fails here, so tests written against memoryStore cannot drift from production. */
const BACKENDS: ReadonlyArray<readonly [string, () => OperatorStore]> = [
  ['memoryStore', () => memoryStore()],
  ['d1Store', () => d1Store(sqliteD1(migratedDb()))]
]

function seat(deviceId: string, overrides: Partial<SeatRow> = {}): SeatRow {
  return {
    device_id: deviceId,
    seat_hash: 'seat',
    os: 'darwin',
    app_version: '1.8.5',
    first_seen: 1000,
    last_seen: 1000,
    country: 'CA',
    city: null,
    region: null,
    lat: null,
    lon: null,
    last_index_at: null,
    hostname: 'host',
    sso_email: 'admin@example.test',
    license: 'licensed',
    approval: 'pending',
    license_jti: null,
    ...overrides
  }
}

function ask(id: string, overrides: Partial<AskRow> = {}): AskRow {
  return {
    id,
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

function tokenRow(kid: string, overrides: Partial<EnrollTokenRow> = {}): EnrollTokenRow {
  return {
    kid,
    secret_hash: 'h'.repeat(64),
    label: 'ci',
    channel: 'release',
    tier: 'reporting',
    license_days: 30,
    max_devices: 2,
    daily_cap: 3,
    enrolled_count: 0,
    created_at: 1000,
    created_by: 'owner@example.test',
    expires_at: 10_000_000,
    revoked_at: null,
    revoked_by: null,
    revoke_reason: null,
    ...overrides
  }
}

function enrollment(id: string, device: string, overrides: Partial<EnrollmentRow> = {}): EnrollmentRow {
  return {
    id,
    device_id: device,
    method: 'token',
    token_kid: 'kid-a',
    sso_oid_hash: null,
    sso_email: null,
    license_jti: `jti-${id}`,
    supersedes: null,
    created_at: 1000,
    app_version: '2.12.0',
    os: 'darwin',
    ...overrides
  }
}

function licence(jti: string, overrides: Partial<IssuedLicenseRow> = {}): IssuedLicenseRow {
  return {
    jti,
    last4: 'abcd',
    key_hash: `hash-${jti}`,
    days: 30,
    iat: 1,
    exp: 5_000_000,
    revoked: 0,
    created_at: 1000,
    created_by: 'test',
    ...overrides
  }
}

describe.each(BACKENDS)('OperatorStore contract: %s', (_name, make) => {
  let store: OperatorStore
  beforeEach(() => {
    store = make()
  })

  it('accepts a nonce once and reports every replay', async () => {
    expect(await store.takeNonce('n-1', 1000)).toBe(false)
    expect(await store.takeNonce('n-1', 1001)).toBe(true)
    expect(await store.takeNonce('n-2', 1001)).toBe(false)
  })

  it('rate-limits a key once it exceeds max inside a window and resets in the next', async () => {
    expect(await store.hitRate('k', 1000, 60_000, 2)).toBe(false)
    expect(await store.hitRate('k', 1001, 60_000, 2)).toBe(false)
    expect(await store.hitRate('k', 1002, 60_000, 2)).toBe(true)
    expect(await store.hitRate('k', 200_000, 60_000, 2)).toBe(false)
  })

  it('round-trips a seat and updates its approval', async () => {
    await store.upsertSeat(seat('dev-a'))
    expect((await store.getSeat('dev-a'))?.hostname).toBe('host')
    expect(await store.getSeat('missing')).toBeNull()
    expect(await store.updateSeatApproval('dev-a', 'approved')).toBe(true)
    expect((await store.getSeat('dev-a'))?.approval).toBe('approved')
    expect(await store.updateSeatApproval('missing', 'approved')).toBe(false)
    expect((await store.listSeats()).map((s) => s.device_id)).toEqual(['dev-a'])
  })

  it('stores an ask once per owner, lists newest first and applies a rating', async () => {
    expect(await store.insertAsk(ask('a-1', { ts: 1000 }))).toBe(true)
    expect(await store.insertAsk(ask('a-1', { device_id: 'dev-b' }))).toBe(false)
    await store.insertAsk(ask('a-2', { ts: 2000 }))
    expect((await store.listAsks(10)).map((a) => a.id)).toEqual(['a-2', 'a-1'])
    expect((await store.listAsks(10, 1500)).map((a) => a.id)).toEqual(['a-2'])
    await store.updateAskRating('a-1', 'up')
    expect((await store.getAsk('a-1'))?.rating).toBe('up')
    expect(await store.getAsk('missing')).toBeNull()
  })

  it('records audit rows newest first with an action filter', async () => {
    await store.audit('e-1', 1000, 'system', 'platform.heartbeat', null, 'first')
    await store.audit('e-2', 2000, 'admin@example.test', 'approve', null, 'second')
    expect((await store.listAudit(10)).map((r) => r.detail)).toEqual(['second', 'first'])
    expect((await store.listAudit(10, { action: 'platform.heartbeat' })).map((r) => r.detail)).toEqual(['first'])
  })

  it('round-trips an enrolment token and revokes it exactly once', async () => {
    await store.putEnrollToken(tokenRow('kid-a'))
    expect(await store.getEnrollToken('kid-a')).toMatchObject({ label: 'ci', channel: 'release', revoked_at: null })
    expect(await store.getEnrollToken('missing')).toBeNull()
    expect((await store.listEnrollTokens()).map((t) => t.kid)).toEqual(['kid-a'])
    expect(await store.revokeEnrollToken('kid-a', 'owner@example.test', 'leaked', 5000)).toBe(true)
    expect(await store.revokeEnrollToken('kid-a', 'someone-else', 'again', 6000)).toBe(false)
    expect(await store.getEnrollToken('kid-a')).toMatchObject({
      revoked_at: 5000,
      revoked_by: 'owner@example.test',
      revoke_reason: 'leaked'
    })
    expect(await store.revokeEnrollToken('nope', 'x', 'y', 1)).toBe(false)
  })

  it('takes token slots atomically: max devices, daily cap, revoked, expired and missing', async () => {
    await store.putEnrollToken(tokenRow('kid-a', { max_devices: 2, daily_cap: 3 }))
    expect(await store.claimEnrollTokenSlot('kid-a', 2000, 0, true)).toBe('ok')
    expect(await store.claimEnrollTokenSlot('kid-a', 2000, 0, true)).toBe('ok')
    expect(await store.claimEnrollTokenSlot('kid-a', 2000, 0, true)).toBe('cap-devices')
    // A device the token already enrolled does not take a slot.
    expect(await store.claimEnrollTokenSlot('kid-a', 2000, 0, false)).toBe('ok')
    expect((await store.getEnrollToken('kid-a'))?.enrolled_count).toBe(2)
    for (const id of ['e1', 'e2', 'e3']) await store.putEnrollment(enrollment(id, `dev-${id}`, { created_at: 2000 }))
    expect(await store.claimEnrollTokenSlot('kid-a', 2000, 1500, false)).toBe('cap-daily')
    expect(await store.claimEnrollTokenSlot('kid-a', 2000, 2500, false)).toBe('ok')
    await store.putEnrollToken(tokenRow('kid-old', { expires_at: 1500 }))
    expect(await store.claimEnrollTokenSlot('kid-old', 2000, 0, true)).toBe('expired')
    await store.putEnrollToken(tokenRow('kid-rev', { revoked_at: 1 }))
    expect(await store.claimEnrollTokenSlot('kid-rev', 2000, 0, true)).toBe('revoked')
    expect(await store.claimEnrollTokenSlot('nope', 2000, 0, true)).toBe('missing')
  })

  it('stores enrolments, lists them newest first and filters by device, token, time and superseding', async () => {
    await store.putEnrollment(enrollment('a', 'dev-1', { created_at: 1000 }))
    await store.putEnrollment(enrollment('b', 'dev-1', { created_at: 2000, supersedes: 'jti-a' }))
    await store.putEnrollment(enrollment('c', 'dev-2', { created_at: 3000, token_kid: 'kid-b' }))
    expect((await store.listEnrollments({})).map((e) => e.id)).toEqual(['c', 'b', 'a'])
    expect((await store.listEnrollments({ deviceId: 'dev-1' })).map((e) => e.id)).toEqual(['b', 'a'])
    expect((await store.listEnrollments({ deviceId: 'dev-1', limit: 1 })).map((e) => e.id)).toEqual(['b'])
    expect((await store.listEnrollments({ tokenKid: 'kid-b' })).map((e) => e.id)).toEqual(['c'])
    expect(await store.countEnrollments({ since: 2000 })).toBe(2)
    expect(await store.countEnrollments({ deviceId: 'dev-1', supersedingOnly: true })).toBe(1)
    expect(await store.countEnrollments({})).toBe(3)
  })

  it('persists origin and supersedes on issued licences, and leaves admin licences untouched', async () => {
    await store.putIssuedLicense(licence('admin-1'))
    await store.putIssuedLicense(
      licence('auto-1', { origin: 'token-enroll', supersedes: 'admin-0', tier: 'reporting' })
    )
    expect(await store.getIssuedLicense('admin-1')).toMatchObject({ jti: 'admin-1' })
    expect((await store.getIssuedLicense('admin-1'))?.origin ?? null).toBeNull()
    expect(await store.getIssuedLicense('auto-1')).toMatchObject({
      origin: 'token-enroll',
      supersedes: 'admin-0',
      tier: 'reporting'
    })
  })

  it('lists active SSO devices per user and cascades a token revocation to its licences only', async () => {
    await store.putIssuedLicense(licence('l1', { origin: 'sso-enroll' }))
    await store.putIssuedLicense(licence('l2', { origin: 'sso-enroll', revoked: 1 }))
    await store.putIssuedLicense(licence('l3', { origin: 'sso-enroll', exp: 100 }))
    await store.putIssuedLicense(licence('l4', { origin: 'token-enroll' }))
    await store.putIssuedLicense(licence('l5', { origin: 'token-enroll' }))
    await store.putEnrollment(
      enrollment('s1', 'dev-1', { method: 'sso', token_kid: null, sso_oid_hash: 'oid-1', license_jti: 'l1' })
    )
    await store.putEnrollment(
      enrollment('s2', 'dev-2', { method: 'sso', token_kid: null, sso_oid_hash: 'oid-1', license_jti: 'l2' })
    )
    await store.putEnrollment(
      enrollment('s3', 'dev-3', { method: 'sso', token_kid: null, sso_oid_hash: 'oid-1', license_jti: 'l3' })
    )
    await store.putEnrollment(
      enrollment('s4', 'dev-4', { method: 'sso', token_kid: null, sso_oid_hash: 'oid-2', license_jti: 'l1' })
    )
    expect((await store.listActiveSsoDevices('oid-1', 1_000_000)).sort()).toEqual(['dev-1'])
    expect(await store.listActiveSsoDevices('oid-none', 1_000_000)).toEqual([])

    await store.putEnrollment(enrollment('t1', 'dev-5', { license_jti: 'l4' }))
    await store.putEnrollment(enrollment('t2', 'dev-6', { license_jti: 'l5', token_kid: 'kid-other' }))
    expect(await store.revokeLicensesEnrolledByToken('kid-a', 7000)).toBe(1)
    expect((await store.getIssuedLicense('l4'))?.revoked).toBe(1)
    expect((await store.getIssuedLicense('l5'))?.revoked).toBe(0)
    expect(await store.revokeLicensesEnrolledByToken('kid-a', 7000)).toBe(0)
  })

  it('records the seat enrolment source, and survives a later heartbeat upsert', async () => {
    await store.upsertSeat(seat('dev-a'))
    await store.setSeatEnrollment('dev-a', 'sso', 'sam@example.test')
    expect(await store.getSeat('dev-a')).toMatchObject({ enroll_method: 'sso', sso_verified_email: 'sam@example.test' })
    await store.upsertSeat(seat('dev-a', { last_seen: 2000 }))
    expect(await store.getSeat('dev-a')).toMatchObject({ enroll_method: 'sso', sso_verified_email: 'sam@example.test' })
    await store.setSeatEnrollment('dev-a', null, null)
    expect((await store.getSeat('dev-a'))?.enroll_method ?? null).toBeNull()
    await expect(store.setSeatEnrollment('ghost', 'token', null)).resolves.toBeUndefined()
  })

  it('keeps small settings as raw JSON text and overwrites on write', async () => {
    expect(await store.getSetting('enroll.paused')).toBeNull()
    await store.putSetting('enroll.paused', 'true', 'owner@example.test', 1000)
    expect(await store.getSetting('enroll.paused')).toBe('true')
    await store.putSetting('enroll.paused', 'false', 'owner@example.test', 2000)
    expect(await store.getSetting('enroll.paused')).toBe('false')
  })

  it('prunes old enrolments only once their licence has expired (or is gone)', async () => {
    await store.putIssuedLicense(licence('old-expired', { exp: 100 }))
    await store.putIssuedLicense(licence('old-active', { exp: 9_000_000 }))
    await store.putEnrollment(enrollment('p1', 'dev-1', { created_at: 10, license_jti: 'old-expired' }))
    await store.putEnrollment(enrollment('p2', 'dev-2', { created_at: 10, license_jti: 'old-active' }))
    await store.putEnrollment(enrollment('p3', 'dev-3', { created_at: 10, license_jti: 'ghost' }))
    await store.putEnrollment(enrollment('p4', 'dev-4', { created_at: 9_000_000_000, license_jti: 'old-expired' }))
    expect(await store.pruneEnrollments(1_000_000, 1_000_000_000, 10)).toBe(2)
    expect((await store.listEnrollments({})).map((e) => e.id).sort()).toEqual(['p2', 'p4'])
  })
})
