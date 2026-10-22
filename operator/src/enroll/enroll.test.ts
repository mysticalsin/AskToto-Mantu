import { beforeEach, describe, expect, it } from 'vitest'
import { OPERATOR_LICENSE_HEADER } from '../../../src/shared/operator-hmac'
import { generateOperatorLicense, verifyOperatorLicense } from '../../../src/shared/operator-license'
import { encryptVault, sha256Hex } from '../crypto'
import { fundedProviders } from '../keys'
import { memoryStore, type OperatorStore, type SeatRow } from '../store'
import { TEST_INGEST_SECRET, TEST_VAULT_KEY } from '../test-fixtures'
import {
  baseEnv,
  call,
  DEVICE,
  DEVICE_2,
  DEVICE_3,
  enrollRequest,
  heartbeat,
  licenseHeader,
  mintToken,
  NOW,
  OID,
  ssoKit,
  type SsoKit
} from './enroll-test-kit'
import { ENROLL_MAX_BODY_BYTES } from './route'

const DAY = 24 * 60 * 60 * 1000

type Json = Record<string, unknown>
const body = async (res: Response): Promise<Json> => (await res.json()) as Json

let store: OperatorStore
let kit: SsoKit
beforeEach(() => {
  store = memoryStore()
  kit = ssoKit()
})

const ssoExtra = () => ({ entraFetch: kit.fetchImpl, entraJwksCache: kit.cache })

async function enrollWithToken(
  token: string,
  o: { device?: string; env?: ReturnType<typeof baseEnv>; now?: number; headers?: Record<string, string> } = {}
): Promise<Response> {
  const now = o.now ?? NOW
  return call(
    store,
    await enrollRequest({
      key: token,
      body: { method: 'token', appVersion: '2.12.0', os: 'darwin' },
      headers: { 'x-metis-enroll': token, ...(o.headers ?? {}) },
      device: o.device,
      ts: now
    }),
    o.env ?? baseEnv(),
    {},
    now
  )
}

async function enrollWithSso(
  idToken: string,
  o: { device?: string; license?: string; now?: number; env?: ReturnType<typeof baseEnv>; key?: string } = {}
): Promise<Response> {
  const now = o.now ?? NOW
  return call(
    store,
    await enrollRequest({
      key: o.key ?? idToken,
      body: { method: 'sso', idToken, appVersion: '2.12.0', os: 'darwin' },
      headers: o.license ? licenseHeader(o.license) : {},
      device: o.device,
      ts: now
    }),
    o.env ?? baseEnv(),
    ssoExtra(),
    now
  )
}

async function renew(license: string, o: { device?: string; now?: number } = {}): Promise<Response> {
  const now = o.now ?? NOW
  return call(
    store,
    await enrollRequest({
      key: license,
      body: { method: 'renew' },
      headers: licenseHeader(license),
      device: o.device,
      ts: now
    }),
    baseEnv(),
    {},
    now
  )
}

async function counts(): Promise<{ issued: number; enrollments: number; seats: number }> {
  return {
    issued: (await store.listIssuedLicenses()).length,
    enrollments: await store.countEnrollments({}),
    seats: (await store.listSeats()).length
  }
}

async function enrolled(
  res: Response
): Promise<{ license: string; jti: string; last4: string; exp: number; origin: string; tier: string }> {
  expect(res.status).toBe(200)
  const json = await body(res)
  expect(json.ok).toBe(true)
  return json as never
}

async function seatRow(device: string, patch: Partial<SeatRow> = {}): Promise<void> {
  await store.upsertSeat({
    device_id: device,
    seat_hash: device,
    os: 'darwin',
    app_version: '2.12.0',
    first_seen: NOW,
    last_seen: NOW,
    country: null,
    city: null,
    lat: null,
    lon: null,
    last_index_at: null,
    hostname: null,
    sso_email: null,
    license: null,
    ...patch
  })
}

describe('POST /v1/enroll: shape and cheap refusals', () => {
  it('refuses a non-POST, a non-JSON content type, a non-object body and an unknown method', async () => {
    const { token } = await mintToken(store)
    const get = await call(store, await enrollRequest({ key: token, method: 'GET' }))
    expect(get.status).toBe(405)
    const text = await call(store, await enrollRequest({ key: token, body: '{}', contentType: 'text/plain' }))
    expect(text.status).toBe(415)
    expect((await body(await call(store, await enrollRequest({ key: token, body: '[]' })))).code).toBe('bad-request')
    expect((await body(await call(store, await enrollRequest({ key: token, body: 'not json' })))).code).toBe(
      'bad-request'
    )
    expect((await body(await call(store, await enrollRequest({ key: token, body: { method: 'admin' } })))).code).toBe(
      'bad-request'
    )
    expect(await counts()).toEqual({ issued: 0, enrollments: 0, seats: 0 })
  })

  it('refuses a malformed device id before touching any storage', async () => {
    const { token } = await mintToken(store)
    const res = await enrollWithToken(token, { device: 'bad id<script>' })
    expect(res.status).toBe(400)
    expect(await counts()).toEqual({ issued: 0, enrollments: 0, seats: 0 })
    expect(await store.listAudit(10, { action: 'enroll-refused' })).toEqual([])
  })

  it('returns 413 for a body over 8 KiB and mints nothing', async () => {
    const { token } = await mintToken(store)
    const big = JSON.stringify({ method: 'token', pad: 'x'.repeat(ENROLL_MAX_BODY_BYTES) })
    const res = await call(store, await enrollRequest({ key: token, body: big, headers: { 'x-metis-enroll': token } }))
    expect(res.status).toBe(413)
    expect((await body(res)).code).toBe('too-large')
    expect(await counts()).toEqual({ issued: 0, enrollments: 0, seats: 0 })
  })

  it('answers every refusal as JSON with a code, never an HTML or redirect response', async () => {
    const res = await call(store, await enrollRequest({ key: 'nope', body: { method: 'token' } }))
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(res.status).toBe(401)
    expect(await body(res)).toMatchObject({ ok: false, code: 'token-invalid' })
  })

  it('honours the per-IP limiter binding and fails open when the binding itself errors', async () => {
    const { token } = await mintToken(store)
    const limited = baseEnv({ ENROLL_IP_LIMITER: { limit: async () => ({ success: false }) } })
    const refused = await enrollWithToken(token, { env: limited })
    expect(refused.status).toBe(429)
    expect((await body(refused)).code).toBe('rate')
    expect(await counts()).toEqual({ issued: 0, enrollments: 0, seats: 0 })
    const broken = baseEnv({
      ENROLL_IP_LIMITER: {
        limit: async () => {
          throw new Error('binding down')
        }
      }
    })
    expect((await enrollWithToken(token, { env: broken, device: DEVICE_2 })).status).toBe(200)
  })

  it('refuses everything with enroll-paused while paused, and works again once unpaused', async () => {
    const { token } = await mintToken(store)
    await store.putSetting('enroll.paused', 'true', 'owner@example.test', NOW)
    const paused = await enrollWithToken(token)
    expect(paused.status).toBe(503)
    expect(await body(paused)).toMatchObject({ code: 'enroll-paused', retryAfterMs: 6 * 60 * 60 * 1000 })
    expect((await enrollWithSso(kit.mint(), { device: DEVICE_2 })).status).toBe(503)
    expect(await counts()).toEqual({ issued: 0, enrollments: 0, seats: 0 })
    await store.putSetting('enroll.paused', 'false', 'owner@example.test', NOW)
    expect((await enrollWithToken(token)).status).toBe(200)
  })

  it('keeps existing seats working while enrolment is paused', async () => {
    const { token } = await mintToken(store)
    const { license } = await enrolled(await enrollWithToken(token))
    await store.putSetting('enroll.paused', 'true', 'owner@example.test', NOW)
    expect((await heartbeat(store, license)).status).toBe(200)
  })
})

describe('method token', () => {
  it('mints a 30-day reporting licence, records the enrolment and audits without leaking the licence', async () => {
    const { token, kid } = await mintToken(store)
    const out = await enrolled(await enrollWithToken(token))
    expect(out).toMatchObject({ origin: 'token', tier: 'reporting' })
    expect(out.exp).toBe(NOW / 1000 + 30 * 86400)
    expect(await verifyOperatorLicense(TEST_INGEST_SECRET, out.license, NOW)).toMatchObject({ ok: true })

    const issued = await store.getIssuedLicense(out.jti)
    expect(issued).toMatchObject({
      origin: 'token-enroll',
      tier: 'reporting',
      member: `device:${DEVICE}`,
      revoked: 0,
      key_hash: await sha256Hex(out.license)
    })
    expect(await store.listEnrollments({ deviceId: DEVICE })).toMatchObject([
      { method: 'token', token_kid: kid, license_jti: out.jti, supersedes: null, app_version: '2.12.0', os: 'darwin' }
    ])
    expect((await store.getEnrollToken(kid))?.enrolled_count).toBe(1)

    const audit = await store.listAudit(10, { action: 'enroll' })
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ actor: `device:${DEVICE}` })
    expect(audit[0].detail).toContain(kid)
    expect(audit[0].detail).toContain(`··${out.last4}`)
    const dump = JSON.stringify([
      await store.listIssuedLicenses(),
      await store.listAudit(50),
      await store.listEnrollTokens()
    ])
    expect(dump).not.toContain(out.license)
    expect(dump).not.toContain(token.split('.')[2])
  })

  it('refuses a wrong secret, a malformed token and an unknown kid identically, and writes nothing', async () => {
    const { token, kid } = await mintToken(store)
    const [prefix, , secret] = token.split('.')
    const wrong = `${prefix}.${kid}.${secret.slice(0, -1)}${secret.endsWith('A') ? 'B' : 'A'}`
    const unknown = `${prefix}.0000000000000000.${secret}`
    for (const bad of [wrong, unknown, 'METIS-ENR-1.zz.zz', '']) {
      const res = await enrollWithToken(bad)
      expect(res.status).toBe(401)
      expect((await body(res)).code).toBe('token-invalid')
    }
    expect(await counts()).toEqual({ issued: 0, enrollments: 0, seats: 0 })
    expect((await store.getEnrollToken(kid))?.enrolled_count).toBe(0)
  })

  it('refuses a revoked token and an expired token', async () => {
    const revoked = await mintToken(store, { label: 'revoked' })
    await store.revokeEnrollToken(revoked.kid, 'owner@example.test', 'test', NOW)
    const r = await enrollWithToken(revoked.token)
    expect(r.status).toBe(403)
    expect((await body(r)).code).toBe('token-revoked')

    const expiring = await mintToken(store, { label: 'short', expiresInDays: 1 })
    const e = await enrollWithToken(expiring.token, { now: NOW + 2 * DAY, device: DEVICE_2 })
    expect(e.status).toBe(403)
    expect((await body(e)).code).toBe('token-expired')
    expect(await counts()).toEqual({ issued: 0, enrollments: 0, seats: 0 })
  })

  it('binds a token to its channel: qa and staging tokens are refused on production, release on staging', async () => {
    const qa = await mintToken(store, { channel: 'qa', label: 'qa' })
    const staging = await mintToken(store, { channel: 'staging', label: 'staging' })
    const release = await mintToken(store, { channel: 'release', label: 'release' })
    for (const t of [qa, staging]) {
      const res = await enrollWithToken(t.token, { device: DEVICE_2 })
      expect(res.status).toBe(401)
      expect((await body(res)).code).toBe('token-invalid')
    }
    const stagingEnv = baseEnv({ OPERATOR_ENV: 'staging' })
    expect((await enrollWithToken(staging.token, { env: stagingEnv, device: DEVICE_2 })).status).toBe(200)
    const refused = await enrollWithToken(release.token, { env: stagingEnv, device: DEVICE_3 })
    expect(refused.status).toBe(401)
    expect((await enrollWithToken(release.token, { device: DEVICE })).status).toBe(200)
  })

  it('refuses a bad request signature without consuming anything, and a replayed nonce', async () => {
    const { token, kid } = await mintToken(store)
    const tampered = await call(
      store,
      await enrollRequest({
        key: token,
        body: { method: 'token', os: 'darwin' },
        signedBody: JSON.stringify({ method: 'token', os: 'win32' }),
        headers: { 'x-metis-enroll': token }
      })
    )
    expect(tampered.status).toBe(401)
    expect((await body(tampered)).code).toBe('signature')
    expect(await counts()).toEqual({ issued: 0, enrollments: 0, seats: 0 })
    expect((await store.getEnrollToken(kid))?.enrolled_count).toBe(0)

    const first = await call(
      store,
      await enrollRequest({
        key: token,
        body: { method: 'token' },
        headers: { 'x-metis-enroll': token },
        nonce: 'fixed-nonce-1'
      })
    )
    expect(first.status).toBe(200)
    const replay = await call(
      store,
      await enrollRequest({
        key: token,
        body: { method: 'token' },
        headers: { 'x-metis-enroll': token },
        nonce: 'fixed-nonce-1'
      })
    )
    expect(replay.status).toBe(401)
    expect((await store.listIssuedLicenses()).length).toBe(1)
  })

  it('refuses a request whose timestamp is outside the skew window', async () => {
    const { token } = await mintToken(store)
    const res = await call(
      store,
      await enrollRequest({
        key: token,
        body: { method: 'token' },
        headers: { 'x-metis-enroll': token },
        ts: NOW - 10 * 60 * 1000
      })
    )
    expect(res.status).toBe(401)
    expect(await counts()).toEqual({ issued: 0, enrollments: 0, seats: 0 })
  })

  it('caps devices per token: the last slot goes to one device, a known device may re-enrol', async () => {
    const { token, kid } = await mintToken(store, { maxDevices: 2 })
    expect((await enrollWithToken(token, { device: DEVICE })).status).toBe(200)
    expect((await enrollWithToken(token, { device: DEVICE_2 })).status).toBe(200)
    const third = await enrollWithToken(token, { device: DEVICE_3 })
    expect(third.status).toBe(403)
    expect((await body(third)).code).toBe('token-cap')
    expect((await enrollWithToken(token, { device: DEVICE })).status).toBe(200)
    expect((await store.getEnrollToken(kid))?.enrolled_count).toBe(2)
  })

  it('caps enrolments per UTC day and resets the next day', async () => {
    const { token } = await mintToken(store, { dailyCap: 1 })
    expect((await enrollWithToken(token, { device: DEVICE })).status).toBe(200)
    const second = await enrollWithToken(token, { device: DEVICE_2 })
    expect(second.status).toBe(403)
    expect((await body(second)).code).toBe('token-cap')
    expect((await enrollWithToken(token, { device: DEVICE_2, now: NOW + DAY })).status).toBe(200)
  })

  it('rate limits per token and per device (counted only after the credential is proven)', async () => {
    const { token, kid } = await mintToken(store)
    for (let i = 0; i < 120; i++) await store.hitRate(`enroll-tok:${kid}`, NOW, 60_000, 120)
    const tokenLimited = await enrollWithToken(token)
    expect(tokenLimited.status).toBe(429)
    expect((await body(tokenLimited)).code).toBe('rate')

    const other = await mintToken(store, { label: 'other' })
    for (let i = 0; i < 5; i++) await store.hitRate(`enroll-dev:${DEVICE_2}`, NOW, 10 * 60_000, 5)
    const deviceLimited = await enrollWithToken(other.token, { device: DEVICE_2 })
    expect(deviceLimited.status).toBe(429)
    expect(await counts()).toEqual({ issued: 0, enrollments: 0, seats: 0 })
    // A stranger without the credential cannot drive the per-device bucket.
    for (let i = 0; i < 8; i++)
      await enrollWithToken('METIS-ENR-1.0000000000000000.' + 'A'.repeat(43), { device: DEVICE_3 })
    expect(await store.hitRate(`enroll-dev:${DEVICE_3}`, NOW, 10 * 60_000, 5)).toBe(false)
  })

  it('refuses a revoked seat across reinstalls, with the same device id', async () => {
    const { token } = await mintToken(store)
    await seatRow(DEVICE, { approval: 'revoked' })
    const res = await enrollWithToken(token)
    expect(res.status).toBe(403)
    expect((await body(res)).code).toBe('seat-revoked')
    expect(await store.listIssuedLicenses()).toEqual([])
  })

  it('never downgrades an administrator grant: an approved seat or an active admin licence is admin-licensed', async () => {
    const { token } = await mintToken(store)
    await seatRow(DEVICE, { approval: 'approved' })
    const approved = await enrollWithToken(token)
    expect(approved.status).toBe(409)
    expect((await body(approved)).code).toBe('admin-licensed')

    const admin = await generateOperatorLicense(TEST_INGEST_SECRET, { days: 30, now: NOW, jti: 'aaaaaaaaaaaaaaaa' })
    await store.putIssuedLicense({
      ...admin.claims,
      key_hash: await sha256Hex(admin.token),
      last4: admin.last4,
      days: 30,
      revoked: 0,
      created_at: NOW,
      created_by: 'owner@example.test',
      tier: 'metis'
    })
    await seatRow(DEVICE_2, { license_jti: admin.claims.jti })
    const adminLicensed = await enrollWithToken(token, { device: DEVICE_2 })
    expect(adminLicensed.status).toBe(409)
    expect((await body(adminLicensed)).code).toBe('admin-licensed')
    expect((await store.listIssuedLicenses()).length).toBe(1)

    // An expired admin licence no longer protects the seat.
    await seatRow(DEVICE_3, { license_jti: admin.claims.jti })
    expect((await enrollWithToken(token, { device: DEVICE_3, now: NOW + 31 * DAY })).status).toBe(200)
  })

  it('writes nothing but one deduplicated audit row per device and code for repeated refusals', async () => {
    const bad = 'METIS-ENR-1.0000000000000000.' + 'A'.repeat(43)
    for (let i = 0; i < 4; i++) await enrollWithToken(bad)
    await enrollWithToken(bad, { device: DEVICE_2 })
    expect(await counts()).toEqual({ issued: 0, enrollments: 0, seats: 0 })
    const rows = await store.listAudit(20, { action: 'enroll-refused' })
    expect(rows.map((r) => [r.actor, r.detail]).sort()).toEqual([
      [`device:${DEVICE}`, 'token · token-invalid'],
      [`device:${DEVICE_2}`, 'token · token-invalid']
    ])
  })
})

describe('re-enrolment, supersede and heartbeat settle', () => {
  it('supersedes the previous licence and revokes it only after the new one binds through a heartbeat', async () => {
    const { token } = await mintToken(store)
    const first = await enrolled(await enrollWithToken(token))
    const second = await enrolled(await enrollWithToken(token))
    expect(second.jti).not.toBe(first.jti)
    expect(await store.getIssuedLicense(second.jti)).toMatchObject({ supersedes: first.jti, origin: 'token-enroll' })
    // Lost response: the old licence is still valid until the new one is proven.
    expect((await store.getIssuedLicense(first.jti))?.revoked).toBe(0)
    expect((await heartbeat(store, first.license)).status).toBe(200)
    expect((await store.getIssuedLicense(first.jti))?.revoked).toBe(0)

    expect((await heartbeat(store, second.license)).status).toBe(200)
    expect((await store.getIssuedLicense(first.jti))?.revoked).toBe(1)
    expect((await store.getIssuedLicense(second.jti))?.revoked).toBe(0)
    const audit = await store.listAudit(20, { action: 'enroll-supersede' })
    expect(audit).toHaveLength(1)
    expect(audit[0].detail).toBe(`··${first.last4} replaced by ··${second.last4}`)
    // The superseded licence can no longer sign anything.
    expect((await heartbeat(store, first.license)).status).toBe(403)
  })

  it('limits re-enrolments to 3 per device per 24 hours', async () => {
    const { token } = await mintToken(store)
    for (let i = 0; i < 4; i++) expect((await enrollWithToken(token)).status).toBe(200)
    const fifth = await enrollWithToken(token)
    expect(fifth.status).toBe(429)
    expect((await body(fifth)).code).toBe('rate')
    expect((await enrollWithToken(token, { now: NOW + DAY + 1000 })).status).toBe(200)
  })

  it('records the seat Source from the proven licence: token, and nothing for an admin licence', async () => {
    const { token } = await mintToken(store)
    const out = await enrolled(await enrollWithToken(token))
    expect((await heartbeat(store, out.license)).status).toBe(200)
    expect(await store.getSeat(DEVICE)).toMatchObject({ enroll_method: 'token', sso_verified_email: null })

    const admin = await generateOperatorLicense(TEST_INGEST_SECRET, { days: 30, now: NOW, jti: 'bbbbbbbbbbbbbbbb' })
    await store.putIssuedLicense({
      ...admin.claims,
      key_hash: await sha256Hex(admin.token),
      last4: admin.last4,
      days: 30,
      revoked: 0,
      created_at: NOW,
      created_by: 'owner@example.test',
      tier: 'metis'
    })
    expect((await heartbeat(store, admin.token, DEVICE_2)).status).toBe(200)
    expect((await store.getSeat(DEVICE_2))?.enroll_method ?? null).toBeNull()
  })
})

describe('reporting tier: no entitlements, no funded providers', () => {
  async function vault(): Promise<void> {
    const encrypted = await encryptVault('provider-test-key', TEST_VAULT_KEY)
    await store.putVaultKey({
      id: 'vault-anthropic',
      provider: 'anthropic',
      label: 'test',
      last4: '-key',
      cipher: encrypted.cipher,
      iv: encrypted.iv,
      status: 'active',
      created_at: NOW,
      created_by: 'owner@example.test',
      rotated_at: null,
      revoked_at: null
    })
  }

  it('heartbeat for a reporting seat returns tier reporting, no entitlements and no funded providers', async () => {
    await vault()
    const { token } = await mintToken(store)
    const out = await enrolled(await enrollWithToken(token))
    const res = await heartbeat(store, out.license)
    expect(res.status).toBe(200)
    expect(await body(res)).toMatchObject({ ok: true, tier: 'reporting', entitlements: [], fundedProviders: [] })
  })

  it('fundedProviders stays populated for a normal licensed seat and is [] for a reporting seat', async () => {
    await vault()
    const { token } = await mintToken(store)
    const out = await enrolled(await enrollWithToken(token))
    expect((await heartbeat(store, out.license)).status).toBe(200)
    const reporting = (await store.getSeat(DEVICE))!
    expect(await fundedProviders(store, reporting, NOW)).toEqual([])

    const admin = await generateOperatorLicense(TEST_INGEST_SECRET, { days: 30, now: NOW, jti: 'cccccccccccccccc' })
    await store.putIssuedLicense({
      ...admin.claims,
      key_hash: await sha256Hex(admin.token),
      last4: admin.last4,
      days: 30,
      revoked: 0,
      created_at: NOW,
      created_by: 'owner@example.test',
      tier: 'metis'
    })
    expect((await heartbeat(store, admin.token, DEVICE_2)).status).toBe(200)
    expect(await fundedProviders(store, (await store.getSeat(DEVICE_2))!, NOW)).toEqual(['anthropic'])
    expect(await fundedProviders(store)).toEqual(['anthropic'])
  })

  it('an explicit Approve lifts an auto-enrolled seat to a normal seat on its next heartbeat', async () => {
    await vault()
    const { token } = await mintToken(store)
    const out = await enrolled(await enrollWithToken(token))
    expect((await heartbeat(store, out.license)).status).toBe(200)
    await store.updateSeatApproval(DEVICE, 'approved')
    const res = await heartbeat(store, out.license)
    const json = await body(res)
    expect(json.tier).toBe('metis')
    expect(json.entitlements).toContain('operator_keys')
    expect(json.fundedProviders).toEqual(['anthropic'])
  })

  it('a non-enrolment licence whose tier is literally reporting is not lifted by approval', async () => {
    const lic = await generateOperatorLicense(TEST_INGEST_SECRET, { days: 30, now: NOW, jti: 'dddddddddddddddd' })
    await store.putIssuedLicense({
      ...lic.claims,
      key_hash: await sha256Hex(lic.token),
      last4: lic.last4,
      days: 30,
      revoked: 0,
      created_at: NOW,
      created_by: 'owner@example.test',
      tier: 'reporting'
    })
    await seatRow(DEVICE, { license_jti: lic.claims.jti, approval: 'approved' })
    const res = await heartbeat(store, lic.token)
    expect(await body(res)).toMatchObject({ tier: 'reporting', entitlements: [] })
  })
})

describe('method sso', () => {
  it('mints a 90-day licence for a verified Entra sign-in and keeps only a salted hash of the object id', async () => {
    const out = await enrolled(await enrollWithSso(kit.mint()))
    expect(out).toMatchObject({ origin: 'sso', tier: 'reporting' })
    expect(out.exp).toBe(NOW / 1000 + 90 * 86400)
    expect(await store.getIssuedLicense(out.jti)).toMatchObject({
      origin: 'sso-enroll',
      member: 'sam.lee@example.test',
      tier: 'reporting'
    })
    const [row] = await store.listEnrollments({ deviceId: DEVICE })
    expect(row).toMatchObject({ method: 'sso', sso_email: 'sam.lee@example.test', token_kid: null })
    expect(row.sso_oid_hash).toBe(await sha256Hex(`${OID}${TEST_INGEST_SECRET}`))
    expect(JSON.stringify(await store.listEnrollments({}))).not.toContain(OID)
    const audit = await store.listAudit(10, { action: 'enroll' })
    expect(audit[0]).toMatchObject({ actor: 'sam.lee@example.test' })
  })

  it('uses the configured SSO tier', async () => {
    await store.putSetting('enroll.sso_tier', JSON.stringify('metis-light'), 'owner@example.test', NOW)
    expect(await enrolled(await enrollWithSso(kit.mint()))).toMatchObject({ tier: 'metis-light' })
  })

  it('rejects a replayed ID token even with a fresh request signature', async () => {
    const token = kit.mint()
    await enrolled(await enrollWithSso(token))
    const replay = await enrollWithSso(token, { device: DEVICE_2 })
    expect(replay.status).toBe(401)
    expect((await body(replay)).code).toBe('sso-replay')
    expect((await store.listIssuedLicenses()).length).toBe(1)
  })

  it('does not burn a real token on a request with a bad signature', async () => {
    const token = kit.mint()
    const bad = await enrollWithSso(token, { key: 'not-the-token' })
    expect(bad.status).toBe(401)
    expect((await body(bad)).code).toBe('signature')
    expect((await enrollWithSso(token)).status).toBe(200)
  })

  it.each([
    ['wrong tenant', { tid: '00000000-0000-4000-8000-000000000009' }, 403, 'sso-tenant'],
    ['wrong audience', { aud: '00000000-0000-4000-8000-000000000008' }, 401, 'sso-invalid'],
    ['wrong issuer', { iss: 'https://login.microsoftonline.com/other/v2.0' }, 401, 'sso-invalid'],
    ['wrong domain', { preferred_username: 'sam@other.test' }, 403, 'sso-domain'],
    ['expired', { exp: NOW / 1000 - 5 }, 401, 'sso-stale'],
    ['older than 10 minutes', { iat: NOW / 1000 - 11 * 60 }, 401, 'sso-stale'],
    ['no oid', { oid: undefined }, 401, 'sso-invalid']
  ])('refuses %s with a code and mints nothing', async (_name, claims, status, code) => {
    const res = await enrollWithSso(kit.mint(claims as Record<string, unknown>))
    expect(res.status).toBe(status)
    expect((await body(res)).code).toBe(code)
    expect(await counts()).toEqual({ issued: 0, enrollments: 0, seats: 0 })
  })

  it('refuses alg none and an unknown signing key', async () => {
    const none = kit.mint({}, { alg: 'none' })
    expect((await body(await enrollWithSso(none))).code).toBe('sso-invalid')
    const other = ssoKit()
    expect((await body(await enrollWithSso(other.mint({}, { key: undefined })))).code).toBe('sso-invalid')
    expect(await counts()).toEqual({ issued: 0, enrollments: 0, seats: 0 })
  })

  it('answers enroll-unavailable (retryable) when the issuer keys cannot be fetched', async () => {
    kit.down()
    const res = await enrollWithSso(kit.mint())
    expect(res.status).toBe(503)
    expect(await body(res)).toMatchObject({ code: 'enroll-unavailable' })
  })

  it('returns 503 enroll-unconfigured for sso when the secrets are missing, while the token path still works', async () => {
    const env = baseEnv({ ENROLL_SSO_TENANT_ID: undefined })
    const sso = await enrollWithSso(kit.mint(), { env })
    expect(sso.status).toBe(503)
    expect((await body(sso)).code).toBe('enroll-unconfigured')
    const { token } = await mintToken(store)
    expect((await enrollWithToken(token, { env })).status).toBe(200)
  })

  it('limits active SSO devices per user, audits the refusal, and lets a known device re-enrol', async () => {
    await store.putSetting('enroll.sso_max_devices_per_user', '2', 'owner@example.test', NOW)
    expect((await enrollWithSso(kit.mint(), { device: DEVICE })).status).toBe(200)
    expect((await enrollWithSso(kit.mint(), { device: DEVICE_2 })).status).toBe(200)
    const third = await enrollWithSso(kit.mint(), { device: DEVICE_3 })
    expect(third.status).toBe(403)
    expect((await body(third)).code).toBe('token-cap')
    expect((await store.listAudit(20, { action: 'enroll-refused' })).map((r) => r.detail)).toContain('sso · token-cap')
    expect((await enrollWithSso(kit.mint(), { device: DEVICE })).status).toBe(200)
  })

  it('upgrades a token seat to SSO: the SSO licence supersedes the token licence and the seat shows the verified e-mail', async () => {
    const { token } = await mintToken(store)
    const tokenLicence = await enrolled(await enrollWithToken(token))
    expect((await heartbeat(store, tokenLicence.license)).status).toBe(200)
    expect((await store.getSeat(DEVICE))?.enroll_method).toBe('token')

    const upgraded = await enrolled(await enrollWithSso(kit.mint(), { license: tokenLicence.license }))
    expect(await store.getIssuedLicense(upgraded.jti)).toMatchObject({
      supersedes: tokenLicence.jti,
      origin: 'sso-enroll'
    })
    expect((await store.getIssuedLicense(tokenLicence.jti))?.revoked).toBe(0)

    expect((await heartbeat(store, upgraded.license)).status).toBe(200)
    expect((await store.getIssuedLicense(tokenLicence.jti))?.revoked).toBe(1)
    expect(await store.getSeat(DEVICE)).toMatchObject({
      enroll_method: 'sso',
      sso_verified_email: 'sam.lee@example.test'
    })
  })

  it('ignores an unusable licence header on an SSO enrolment instead of failing it', async () => {
    const out = await enrolled(await enrollWithSso(kit.mint(), { license: 'METIS-OP-1.garbage' }))
    expect((await store.getIssuedLicense(out.jti))?.supersedes ?? null).toBeNull()
  })
})

describe('method renew', () => {
  it('renews with the current licence: same origin and tier, supersedes it, keeps the token attribution', async () => {
    const { token, kid } = await mintToken(store)
    const first = await enrolled(await enrollWithToken(token))
    expect((await heartbeat(store, first.license)).status).toBe(200)
    const renewed = await enrolled(await renew(first.license))
    expect(renewed).toMatchObject({ origin: 'token', tier: 'reporting' })
    expect(await store.getIssuedLicense(renewed.jti)).toMatchObject({ supersedes: first.jti, origin: 'token-enroll' })
    const [row] = await store.listEnrollments({ deviceId: DEVICE, limit: 1 })
    expect(row).toMatchObject({ method: 'renew', token_kid: kid, supersedes: first.jti })
    expect((await store.getIssuedLicense(first.jti))?.revoked).toBe(0)
    expect((await heartbeat(store, renewed.license)).status).toBe(200)
    expect((await store.getIssuedLicense(first.jti))?.revoked).toBe(1)
  })

  it('renews an SSO seat for 90 days and keeps the verified e-mail', async () => {
    const first = await enrolled(await enrollWithSso(kit.mint()))
    expect((await heartbeat(store, first.license)).status).toBe(200)
    const renewed = await enrolled(await renew(first.license))
    expect(renewed.origin).toBe('sso')
    expect(renewed.exp).toBe(NOW / 1000 + 90 * 86400)
    expect((await store.getIssuedLicense(renewed.jti))?.member).toBe('sam.lee@example.test')
  })

  it('refuses a renewal without a licence, with an expired licence, a revoked licence and an admin licence', async () => {
    const none = await call(store, await enrollRequest({ key: 'x', body: { method: 'renew' } }))
    expect(none.status).toBe(401)
    expect((await body(none)).code).toBe('license-invalid')

    const { token } = await mintToken(store)
    const first = await enrolled(await enrollWithToken(token))
    expect((await heartbeat(store, first.license)).status).toBe(200)
    const expired = await renew(first.license, { now: NOW + 31 * DAY })
    expect(expired.status).toBe(403)
    expect((await body(expired)).code).toBe('license-expired')

    await store.revokeIssuedLicense(first.jti, NOW)
    const revoked = await renew(first.license)
    expect(revoked.status).toBe(403)
    expect((await body(revoked)).code).toBe('license-revoked')

    const admin = await generateOperatorLicense(TEST_INGEST_SECRET, { days: 30, now: NOW, jti: 'eeeeeeeeeeeeeeee' })
    await store.putIssuedLicense({
      ...admin.claims,
      key_hash: await sha256Hex(admin.token),
      last4: admin.last4,
      days: 30,
      revoked: 0,
      created_at: NOW,
      created_by: 'owner@example.test',
      tier: 'metis'
    })
    expect((await heartbeat(store, admin.token, DEVICE_2)).status).toBe(200)
    const adminRenew = await renew(admin.token, { device: DEVICE_2 })
    expect(adminRenew.status).toBe(409)
    expect((await body(adminRenew)).code).toBe('admin-licensed')
  })

  it('does not let a renewal through for a revoked seat', async () => {
    const { token } = await mintToken(store)
    const first = await enrolled(await enrollWithToken(token))
    expect((await heartbeat(store, first.license)).status).toBe(200)
    await store.updateSeatApproval(DEVICE, 'revoked')
    const res = await renew(first.license)
    expect(res.status).toBe(403)
    expect((await body(res)).code).toBe('seat-revoked')
  })
})

describe('Access bypass and headers', () => {
  it('lists /v1/enroll as a Cloudflare Access bypass path', async () => {
    const { ACCESS_BYPASS_PATHS } = await import('../access')
    expect(ACCESS_BYPASS_PATHS).toContain('/v1/enroll')
  })

  it('never sets a licence or token in a header, and marks responses no-store', async () => {
    const { token } = await mintToken(store)
    const res = await enrollWithToken(token)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get(OPERATOR_LICENSE_HEADER)).toBeNull()
  })
})
