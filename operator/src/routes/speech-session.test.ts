import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateOperatorLicense } from '../../../src/shared/operator-license'
import { ingestCanonical, OPERATOR_HMAC_HEADERS, OPERATOR_LICENSE_HEADER } from '../../../src/shared/operator-hmac'
import { sha256Hex } from '../crypto'
import { hmacHex } from '../hmac'
import { handleRequest, type Env } from '../index'
import { d1Store, type D1DatabaseLike } from '../d1'
import type { OperatorStore } from '../store'
import { sqliteD1, migratedDb } from '../test-d1'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY } from '../test-fixtures'

const NOW = 1_725_000_000_000
const DEVICE = 'speech-device-0001'
const OTHER_DEVICE = 'speech-device-0002'
const TENANT = 'metis-speech-test'
const AUDIENCE = 'operator-test'
const TOKEN = {
  routeId: 'workers-ai-nova3' as const,
  modelId: '@cf/deepgram/nova-3',
  configVersion: 'route-config-1',
  tenantId: TENANT,
  audience: AUDIENCE,
  privacy: 'VERIFIED' as const,
  transportConsumer: 'REGISTERED' as const,
  synthetic: true as const
}

const baseEnv: Env = {
  OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET,
  OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY,
  OPERATOR_SKILL_PRIVATE_KEY: '',
  SPEECH_TENANT_ID: TENANT,
  SPEECH_AUDIENCE: AUDIENCE,
  SPEECH_POLICY_VERSION: 'policy-1',
  SPEECH_ROUTE_ID: 'workers-ai-nova3',
  SPEECH_MODEL_ID: '@cf/deepgram/nova-3',
  SPEECH_CONFIG_VERSION: 'route-config-1',
  SPEECH_ALLOWED_LANGUAGES: 'en,en-US',
  SPEECH_MAX_CONCURRENT_SESSIONS: '2',
  SPEECH_MAX_CONCURRENT_TRACKS: '4',
  SPEECH_BUDGET_WINDOW_MS: '3600000',
  SPEECH_BUDGET_MAX_MS: '1800000',
  SPEECH_MAX_SESSION_MS: '300000'
}

function sessionBody(patch: Record<string, unknown> = {}) {
  return {
    operation: 'create-session',
    captureGeneration: 7,
    tracks: ['microphone', 'system'],
    language: 'en',
    consent: {
      accepted: true,
      captureGeneration: 7,
      tracks: ['microphone', 'system'],
      issuedAt: NOW - 1_000,
      expiresAt: NOW + 60_000
    },
    ...patch
  }
}

async function createFixture() {
  const db: DatabaseSync = migratedDb()
  const d1 = sqliteD1(db)
  const store = d1Store(d1)
  await store.putTier({ id: 'metis', label: 'Métis', entitlements_json: JSON.stringify(['listen', 'operator_keys']), updated_at: NOW })
  const tokens = new Map<string, string>()
  for (const [device, jti] of [[DEVICE, 'aaaaaaaaaaaaaaaa'], [OTHER_DEVICE, 'bbbbbbbbbbbbbbbb']]) {
    const issued = await generateOperatorLicense(TEST_INGEST_SECRET, { days: 7, now: NOW, jti })
    tokens.set(device, issued.token)
    await store.putIssuedLicense({
      ...issued.claims,
      last4: issued.last4,
      key_hash: await sha256Hex(issued.token),
      days: 7,
      revoked: 0,
      created_at: NOW,
      created_by: 'test-owner',
      tier: 'metis',
      activated_device: device,
      activated_at: NOW
    })
    await store.upsertSeat({
      device_id: device,
      seat_hash: 'test-hash',
      os: 'win32',
      app_version: 'test',
      first_seen: NOW,
      last_seen: NOW,
      country: null,
      city: null,
      region: null,
      lat: null,
      lon: null,
      last_index_at: null,
      hostname: null,
      sso_email: null,
      license: 'licensed',
      approval: 'approved',
      license_jti: issued.claims.jti
    })
  }
  return { db, d1, store, tokens }
}

async function signedRequest(options: {
  device?: string
  token?: string | null
  secret?: string
  path?: string
  body?: unknown
  nonce?: string
}) {
  const device = options.device ?? DEVICE
  const token = options.token === undefined ? '' : options.token
  const nonce = options.nonce ?? crypto.randomUUID()
  const timestamp = String(NOW)
  const bodyText = JSON.stringify(options.body ?? sessionBody())
  const signingSecret = options.secret ?? token ?? TEST_INGEST_SECRET
  const signature = await hmacHex(signingSecret, ingestCanonical(timestamp, nonce, device, await sha256Hex(bodyText)))
  return new Request(`https://operator.test${options.path ?? '/v1/speech/sessions'}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { [OPERATOR_LICENSE_HEADER]: token }),
      [OPERATOR_HMAC_HEADERS.device]: device,
      [OPERATOR_HMAC_HEADERS.ts]: timestamp,
      [OPERATOR_HMAC_HEADERS.nonce]: nonce,
      [OPERATOR_HMAC_HEADERS.sig]: signature
    },
    body: bodyText
  })
}

describe('authenticated speech session broker boundary', () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>
  beforeEach(async () => { fixture = await createFixture() })

  it('rejects legacy fleet HMAC without allocating a session', async () => {
    const response = await handleRequest(await signedRequest({ token: null, secret: TEST_INGEST_SECRET }), baseEnv, {}, {
      store: fixture.store, now: NOW
    })
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ ok: false, code: 'license-required' })
    expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM speech_sessions').get()).toMatchObject({ n: 0 })
  })

  it('fails closed without verified server privacy and consumer evidence', async () => {
    const response = await handleRequest(await signedRequest({ token: fixture.tokens.get(DEVICE) }), {
      ...baseEnv, DB: fixture.d1
    }, {}, { store: fixture.store, now: NOW })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ ok: false, code: 'PRIVACY_UNVERIFIED' })
    expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM speech_sessions').get()).toMatchObject({ n: 0 })
  })

  it('creates only a synthetic test grant after exact licensed authorization and policy evidence', async () => {
    const providerFetch = vi.fn(async () => new Response('unexpected upstream'))
    const response = await handleRequest(await signedRequest({ token: fixture.tokens.get(DEVICE) }), {
      ...baseEnv, DB: fixture.d1
    }, {}, { store: fixture.store, now: NOW, speechPolicyEvidence: TOKEN, providerFetch })
    expect(response.status).toBe(200)
    const body = await response.json() as { ok: boolean; sessionId: string; grants: Array<{ track: string; token: string }> }
    expect(body.ok).toBe(true)
    expect(body.grants.map((grant) => grant.track)).toEqual(['microphone', 'system'])
    expect(body.grants.every((grant) => grant.token.length === 43)).toBe(true)
    expect(providerFetch).not.toHaveBeenCalled()
    for (const grant of body.grants) {
      expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM speech_grants WHERE token_hash = ?').get(grant.token)).toMatchObject({ n: 0 })
    }
  })

  it('rejects body/path cancellation mismatch and cross-device session cancellation', async () => {
    const create = await handleRequest(await signedRequest({ token: fixture.tokens.get(DEVICE) }), {
      ...baseEnv, DB: fixture.d1
    }, {}, { store: fixture.store, now: NOW, speechPolicyEvidence: TOKEN })
    const created = await create.json() as { sessionId: string }
    const wrongBody = await handleRequest(await signedRequest({
      token: fixture.tokens.get(DEVICE),
      path: `/v1/speech/sessions/${created.sessionId}/cancel`,
      body: { operation: 'cancel-session', sessionId: crypto.randomUUID() }
    }), { ...baseEnv, DB: fixture.d1 }, {}, { store: fixture.store, now: NOW, speechPolicyEvidence: TOKEN })
    expect(wrongBody.status).toBe(400)

    const otherDevice = await handleRequest(await signedRequest({
      device: OTHER_DEVICE,
      token: fixture.tokens.get(OTHER_DEVICE),
      path: `/v1/speech/sessions/${created.sessionId}/cancel`,
      body: { operation: 'cancel-session', sessionId: created.sessionId }
    }), { ...baseEnv, DB: fixture.d1 }, {}, { store: fixture.store, now: NOW })
    expect(otherDevice.status).toBe(404)
    expect(await otherDevice.json()).toMatchObject({ code: 'SESSION_NOT_FOUND' })
  })

  it('rejects stale consent and request replay without creating paid reservations', async () => {
    const stale = sessionBody({ consent: {
      accepted: true, captureGeneration: 7, tracks: ['microphone', 'system'],
      issuedAt: NOW - 180_000, expiresAt: NOW - 1
    } })
    const staleResponse = await handleRequest(await signedRequest({ token: fixture.tokens.get(DEVICE), body: stale }), {
      ...baseEnv, DB: fixture.d1
    }, {}, { store: fixture.store, now: NOW, speechPolicyEvidence: TOKEN })
    expect(staleResponse.status).toBe(400)
    expect(await staleResponse.json()).toMatchObject({ code: 'CONSENT_EXPIRED' })

    const nonce = crypto.randomUUID()
    const make = () => signedRequest({ token: fixture.tokens.get(DEVICE), nonce })
    const first = await handleRequest(await make(), { ...baseEnv, DB: fixture.d1 }, {}, { store: fixture.store, now: NOW })
    const replay = await handleRequest(await make(), { ...baseEnv, DB: fixture.d1 }, {}, { store: fixture.store, now: NOW })
    expect(first.status).toBe(403)
    expect(replay.status).toBe(401)
    expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM speech_sessions').get()).toMatchObject({ n: 0 })
  })

  it('rejects unbounded body input before parsing or database writes', async () => {
    const request = await signedRequest({ token: fixture.tokens.get(DEVICE), body: { ...sessionBody(), padding: 'x'.repeat(9_000) } })
    const response = await handleRequest(request, { ...baseEnv, DB: fixture.d1 }, {}, { store: fixture.store, now: NOW })
    expect(response.status).toBe(413)
    expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM speech_sessions').get()).toMatchObject({ n: 0 })
  })
})
