import { beforeEach, describe, expect, it } from 'vitest'
import { handleRequest } from '../index'
import { memoryStore, type OperatorStore } from '../store'
import { TEST_ADMIN_EMAIL, TEST_OWNER_EMAIL } from '../test-fixtures'
import {
  baseEnv,
  call,
  CLIENT,
  DEVICE,
  DEVICE_2,
  enrollRequest,
  mintToken,
  NOW,
  ownerAccess,
  TENANT
} from '../enroll/enroll-test-kit'
import { ENROLL_TOKEN_PREFIX } from '../enroll/tokens'

type Json = Record<string, unknown>

let store: OperatorStore
beforeEach(() => {
  store = memoryStore()
})

async function admin(
  method: string,
  path: string,
  payload?: unknown,
  o: { email?: string | null; env?: ReturnType<typeof baseEnv>; headers?: Record<string, string>; now?: number } = {}
): Promise<{ status: number; json: Json }> {
  const res = await handleRequest(
    new Request(`https://operator.test${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(o.headers ?? {}) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
    }),
    o.env ?? baseEnv(),
    {},
    {
      store,
      now: o.now ?? NOW,
      ...(o.email === null ? {} : { access: ownerAccess(o.email ?? TEST_OWNER_EMAIL) })
    }
  )
  return { status: res.status, json: (await res.json()) as Json }
}

const create = (payload: unknown = { label: 'CI release', channel: 'release' }, email?: string) =>
  admin('POST', '/v1/admin/enroll-tokens', payload, { email })

describe('GET /v1/admin/enroll-tokens', () => {
  it('is 401 JSON without an Access identity', async () => {
    const res = await admin('GET', '/v1/admin/enroll-tokens', undefined, { email: null })
    expect(res.status).toBe(401)
  })

  it('lists tokens, settings and SSO status to any admin, never a secret or a hash, never the full tenant', async () => {
    const { token } = await mintToken(store)
    const res = await admin('GET', '/v1/admin/enroll-tokens', undefined, { email: TEST_ADMIN_EMAIL })
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({
      ok: true,
      isOwner: false,
      channel: 'release',
      settings: { paused: false, ssoTier: 'reporting', ssoMaxDevicesPerUser: 10 },
      sso: { configured: true, tenantLast4: TENANT.slice(-4), clientIdCount: 1, domainCount: 1 }
    })
    const text = JSON.stringify(res.json)
    expect(text).not.toContain(token.split('.')[2])
    expect(text).not.toContain('secret_hash')
    expect(text).not.toContain(TENANT)
    expect(text).not.toContain(CLIENT)
    expect(res.json.tokens).toMatchObject([
      { label: 'ci release', channel: 'release', tier: 'reporting', status: 'active', enrolledToday: 0 }
    ])
  })

  it('reports SSO as not configured when the Worker secrets are absent', async () => {
    const res = await admin('GET', '/v1/admin/enroll-tokens', undefined, {
      env: baseEnv({ ENROLL_SSO_CLIENT_IDS: undefined })
    })
    expect(res.json.sso).toEqual({ configured: false, tenantLast4: null, clientIdCount: 0, domainCount: 0 })
  })

  it('counts devices enrolled today per token', async () => {
    const { token, kid } = await mintToken(store)
    for (const device of [DEVICE, DEVICE_2]) {
      const res = await call(
        store,
        await enrollRequest({ key: token, body: { method: 'token' }, headers: { 'x-metis-enroll': token }, device })
      )
      expect(res.status).toBe(200)
    }
    const res = await admin('GET', '/v1/admin/enroll-tokens')
    expect(res.json.tokens).toMatchObject([{ kid, enrolledCount: 2, enrolledToday: 2 }])
  })
})

describe('POST /v1/admin/enroll-tokens', () => {
  it('creates a token for an owner, shows it once, stores only a hash and audits without the secret', async () => {
    const res = await create({
      label: 'Release 2.12',
      channel: 'release',
      expiresInDays: 90,
      maxDevices: 100,
      dailyCap: 10
    })
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({
      ok: true,
      label: 'Release 2.12',
      channel: 'release',
      shownOnce: true,
      maxDevices: 100,
      dailyCap: 10
    })
    const token = res.json.token as string
    expect(token).toMatch(new RegExp(`^${ENROLL_TOKEN_PREFIX}\\.[0-9a-f]{16}\\.[A-Za-z0-9_-]{43}$`))
    expect(res.json.expiresAt).toBe(NOW + 90 * 86400_000)

    const [row] = await store.listEnrollTokens()
    expect(row).toMatchObject({
      kid: res.json.kid,
      tier: 'reporting',
      license_days: 30,
      created_by: TEST_OWNER_EMAIL,
      enrolled_count: 0
    })
    expect(JSON.stringify(row)).not.toContain(token.split('.')[2])
    expect(row.secret_hash).toMatch(/^[0-9a-f]{64}$/)

    const audit = await store.listAudit(10, { action: 'enroll-token-create' })
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ actor: TEST_OWNER_EMAIL })
    expect(audit[0].detail).toContain(row.kid)
    expect(JSON.stringify(audit)).not.toContain(token.split('.')[2])

    // Listing afterwards never returns the token again.
    expect(JSON.stringify((await admin('GET', '/v1/admin/enroll-tokens')).json)).not.toContain(token.split('.')[2])
  })

  it('ignores any attempt to choose a tier or licence length: a token only ever mints 30-day reporting licences', async () => {
    const res = await create({ label: 'x', channel: 'release', tier: 'metis', licenseDays: 365, license_days: 365 })
    expect(res.status).toBe(200)
    expect((await store.listEnrollTokens())[0]).toMatchObject({ tier: 'reporting', license_days: 30 })
  })

  it('is owner-only: a plain admin is refused, audited, and nothing is created', async () => {
    const res = await create(undefined, TEST_ADMIN_EMAIL)
    expect(res.status).toBe(403)
    expect(res.json).toMatchObject({ ok: false, code: 'not-owner' })
    expect(await store.listEnrollTokens()).toEqual([])
    expect(await store.listAudit(5, { action: 'enroll-admin.denied' })).toHaveLength(1)
  })

  it('is refused for every admin when OWNER_EMAILS is not configured (fail closed)', async () => {
    const res = await admin(
      'POST',
      '/v1/admin/enroll-tokens',
      { label: 'x', channel: 'release' },
      { env: baseEnv({ OWNER_EMAILS: undefined }) }
    )
    expect(res.status).toBe(403)
  })

  it.each([
    [{ channel: 'release' }, 'label'],
    [{ label: '', channel: 'release' }, 'label'],
    [{ label: 'x'.repeat(65), channel: 'release' }, 'label'],
    [{ label: 'x', channel: 'prod' }, 'channel'],
    [{ label: 'x' }, 'channel'],
    [{ label: 'x', channel: 'qa', expiresInDays: 0 }, 'expiresInDays'],
    [{ label: 'x', channel: 'qa', expiresInDays: 366 }, 'expiresInDays'],
    [{ label: 'x', channel: 'qa', maxDevices: 0 }, 'maxDevices'],
    [{ label: 'x', channel: 'qa', dailyCap: 1.5 }, 'dailyCap'],
    [{ label: 'x', channel: 'qa', dailyCap: '5' }, 'dailyCap']
  ])('rejects invalid input %j', async (payload, field) => {
    const res = await create(payload)
    expect(res.status).toBe(400)
    expect(String(res.json.error)).toContain(field)
    expect(await store.listEnrollTokens()).toEqual([])
  })

  it('refuses a cross-site browser request (CSRF gate)', async () => {
    const res = await admin(
      'POST',
      '/v1/admin/enroll-tokens',
      { label: 'x', channel: 'release' },
      { headers: { 'sec-fetch-site': 'cross-site' } }
    )
    expect(res.status).toBe(403)
    expect(res.json.code).toBe('csrf')
    expect(await store.listEnrollTokens()).toEqual([])
  })
})

describe('POST /v1/admin/enroll-tokens/:kid/revoke', () => {
  async function enrollTwo(token: string): Promise<string[]> {
    const jtis: string[] = []
    for (const device of [DEVICE, DEVICE_2]) {
      const res = await call(
        store,
        await enrollRequest({ key: token, body: { method: 'token' }, headers: { 'x-metis-enroll': token }, device })
      )
      jtis.push(((await res.json()) as Json).jti as string)
    }
    return jtis
  }

  it('revokes a token so it can no longer enrol, leaving already enrolled devices alone by default', async () => {
    const { token, kid } = await mintToken(store)
    const [jti] = await enrollTwo(token)
    const res = await admin('POST', `/v1/admin/enroll-tokens/${kid}/revoke`, { reason: 'leaked in a log' })
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ ok: true, kid, cascaded: 0 })
    expect(await store.getEnrollToken(kid)).toMatchObject({
      revoked_by: TEST_OWNER_EMAIL,
      revoke_reason: 'leaked in a log',
      revoked_at: NOW
    })
    expect((await store.getIssuedLicense(jti))?.revoked).toBe(0)

    const refused = await call(
      store,
      await enrollRequest({
        key: token,
        body: { method: 'token' },
        headers: { 'x-metis-enroll': token },
        device: 'enroll-device-0009'
      })
    )
    expect(refused.status).toBe(403)
    expect(((await refused.json()) as Json).code).toBe('token-revoked')
    expect((await admin('GET', '/v1/admin/enroll-tokens')).json.tokens).toMatchObject([{ kid, status: 'revoked' }])
  })

  it('cascades to every licence the token minted when asked, and only those', async () => {
    const { token, kid } = await mintToken(store)
    const other = await mintToken(store, { label: 'other' })
    const [a, b] = await enrollTwo(token)
    const unrelated = await call(
      store,
      await enrollRequest({
        key: other.token,
        body: { method: 'token' },
        headers: { 'x-metis-enroll': other.token },
        device: 'enroll-device-0008'
      })
    )
    const unrelatedJti = ((await unrelated.json()) as Json).jti as string

    const res = await admin('POST', `/v1/admin/enroll-tokens/${kid}/revoke`, { cascade: true })
    expect(res.json).toMatchObject({ ok: true, cascaded: 2 })
    expect((await store.getIssuedLicense(a))?.revoked).toBe(1)
    expect((await store.getIssuedLicense(b))?.revoked).toBe(1)
    expect((await store.getIssuedLicense(unrelatedJti))?.revoked).toBe(0)
    const audit = await store.listAudit(10, { action: 'enroll-token-revoke' })
    expect(audit).toHaveLength(1)
    expect(audit[0].detail).toContain('cascade 2 licences')
  })

  it('is 404 for an unknown token, 409 when already revoked, and owner-only', async () => {
    const { kid } = await mintToken(store)
    expect((await admin('POST', '/v1/admin/enroll-tokens/ffffffffffffffff/revoke', {})).status).toBe(404)
    expect((await admin('POST', `/v1/admin/enroll-tokens/${kid}/revoke`, {}, { email: TEST_ADMIN_EMAIL })).status).toBe(
      403
    )
    expect((await store.getEnrollToken(kid))?.revoked_at).toBeNull()
    expect((await admin('POST', `/v1/admin/enroll-tokens/${kid}/revoke`, {})).status).toBe(200)
    const again = await admin('POST', `/v1/admin/enroll-tokens/${kid}/revoke`, {})
    expect(again.status).toBe(409)
    expect(again.json.code).toBe('already-revoked')
  })

  it('does not match a malformed kid', async () => {
    expect((await admin('POST', '/v1/admin/enroll-tokens/not-a-kid/revoke', {})).status).toBe(404)
  })
})

describe('POST /v1/admin/settings/enroll', () => {
  it('pauses and resumes enrolment, validates values, audits before/after and is owner-only', async () => {
    const paused = await admin('POST', '/v1/admin/settings/enroll', { paused: true })
    expect(paused.json).toMatchObject({ ok: true, settings: { paused: true } })
    expect((await admin('GET', '/v1/admin/enroll-tokens')).json.settings).toMatchObject({ paused: true })

    const set = await admin('POST', '/v1/admin/settings/enroll', { ssoTier: 'metis-light', ssoMaxDevicesPerUser: 3 })
    expect(set.json).toMatchObject({ settings: { paused: true, ssoTier: 'metis-light', ssoMaxDevicesPerUser: 3 } })
    const audit = await store.listAudit(10, { action: 'enroll-settings-update' })
    expect(audit).toHaveLength(2)
    expect(audit[0].detail).toContain('before')
    expect(audit[0].detail).toContain('after')

    expect((await admin('POST', '/v1/admin/settings/enroll', { paused: 'yes' })).status).toBe(400)
    expect((await admin('POST', '/v1/admin/settings/enroll', { ssoTier: 'no-such-tier' })).status).toBe(400)
    expect((await admin('POST', '/v1/admin/settings/enroll', { ssoMaxDevicesPerUser: 0 })).status).toBe(400)
    expect((await admin('POST', '/v1/admin/settings/enroll', { ssoMaxDevicesPerUser: 101 })).status).toBe(400)
    expect((await admin('POST', '/v1/admin/settings/enroll', {})).status).toBe(400)
    expect(
      (await admin('POST', '/v1/admin/settings/enroll', { paused: false }, { email: TEST_ADMIN_EMAIL })).status
    ).toBe(403)
    expect((await admin('GET', '/v1/admin/enroll-tokens')).json.settings).toMatchObject({
      paused: true,
      ssoTier: 'metis-light'
    })
  })

  it('the pause takes effect on /v1/enroll immediately, with no deploy', async () => {
    const { token } = await mintToken(store)
    await admin('POST', '/v1/admin/settings/enroll', { paused: true })
    const refused = await call(
      store,
      await enrollRequest({ key: token, body: { method: 'token' }, headers: { 'x-metis-enroll': token } })
    )
    expect(refused.status).toBe(503)
    await admin('POST', '/v1/admin/settings/enroll', { paused: false })
    const ok = await call(
      store,
      await enrollRequest({ key: token, body: { method: 'token' }, headers: { 'x-metis-enroll': token } })
    )
    expect(ok.status).toBe(200)
  })
})

describe('console and dashboard carry the enrolment panel', () => {
  it('GET /v1/admin/dashboard includes the enrolment slice and never a secret', async () => {
    const { token, kid } = await mintToken(store)
    const res = await admin('GET', '/v1/admin/dashboard')
    expect(res.status).toBe(200)
    expect(res.json.enrollment).toMatchObject({
      isOwner: true,
      channel: 'release',
      settings: { paused: false },
      sso: { configured: true, tenantLast4: TENANT.slice(-4) },
      tokens: [{ kid, label: 'ci release', status: 'active' }]
    })
    expect(JSON.stringify(res.json)).not.toContain(token.split('.')[2])
    expect(JSON.stringify(res.json)).not.toContain(TENANT)
  })

  it('the server-rendered Settings page shows the panel with the owner controls', async () => {
    await mintToken(store)
    const res = await handleRequest(
      new Request('https://operator.test/settings', { headers: { accept: 'text/html' } }),
      baseEnv(),
      {},
      { store, now: NOW, access: ownerAccess() }
    )
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('data-enroll-panel')
    expect(html).toContain('data-enroll-create')
    expect(html).toContain('ci release')
  })
})
