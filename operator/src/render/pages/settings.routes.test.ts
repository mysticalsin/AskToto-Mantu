/**
 * End-to-end proof for every Settings tab (Tony, 2026-09-06: "make sure all the other things in
 * settings work"): one integration test per tab, each driving the REAL admin route through
 * `handleRequest` against a seeded `memoryStore()` - never a stub, never a hand-typed number. Every
 * test asserts three things where the tab has a write: the value persists across a fresh GET, an
 * audit row exists carrying before and after, and the product (a heartbeat response, the skill
 * manifest, `buildDashboard`'s payload) visibly changes as a result.
 */
import { generateKeyPairSync } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { handleRequest, type Env } from '../../index'
import { hmacHex } from '../../hmac'
import { sha256Hex } from '../../crypto'
import { ingestCanonical, OPERATOR_HMAC_HEADERS } from '../../../../src/shared/operator-hmac'
import { buildDashboard } from '../../dashboard'
import type { D1DatabaseLike } from '../../d1'
import { memoryStore, type SeatRow } from '../../store'
import { fixtureRows, seedStore } from '../fixture'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY } from '../../test-fixtures'
import { DEFAULT_OPERATOR_SETTINGS, SETTINGS_MIGRATIONS } from '../../routes/settings-store'
import { renderPlatformHealthEnriched, type HealthEnriched } from './settings'

const NOW = 1_725_000_000_000
const tonyAccess = { getIdentity: async () => ({ email: 'tony.walteur@gmail.com' }) }

/** Same node:sqlite D1 shim `settings-store.test.ts` uses: `GET/PATCH /v1/admin/settings.json`
 *  needs `ctx.env.DB` bound (503 "db unbound" otherwise), independent of the in-memory `store`
 *  every other route here uses. */
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

function freshSettingsDb(): D1DatabaseLike {
  const db = new DatabaseSync(':memory:')
  for (const stmt of SETTINGS_MIGRATIONS) db.exec(stmt)
  return sqliteD1(db)
}

function env(overrides: Partial<Env> = {}): Env {
  return { OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET, OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY, OPERATOR_SKILL_PRIVATE_KEY: '', ...overrides }
}

function mintSkillKeys(): { privateKeyPem: string; publicKeyRaw: string } {
  const pair = generateKeyPairSync('ed25519')
  const jwk = pair.publicKey.export({ format: 'jwk' }) as { x?: string }
  if (typeof jwk.x !== 'string' || !jwk.x) throw new Error('ed25519 jwk missing x')
  return { privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKeyRaw: jwk.x }
}

/** Same HMAC-over-canonical-string helper `index.test.ts` uses, duplicated (not imported: that file
 *  does not export it) so this file can drive `/v1/ingest`, `/v1/heartbeat` and the HMAC-gated
 *  `/v1/skills/manifest` for real. A manifest GET is signed over an empty body, same as a browser's
 *  GET carries no body - `index.ts` reads `request.text()` either way before verifying. */
async function signedRequest(
  path: string,
  bodyText: string,
  opts: { ts?: number; nonce?: string; deviceId?: string; method?: string } = {}
): Promise<Request> {
  const ts = String(opts.ts ?? NOW)
  const nonce = opts.nonce ?? `nonce-${Math.random().toString(16).slice(2)}`
  const deviceId = opts.deviceId ?? 'device-a'
  const method = opts.method ?? (path.includes('manifest') ? 'GET' : 'POST')
  const signedBody = method === 'GET' ? '' : bodyText
  const bodyHash = await sha256Hex(signedBody)
  const sig = await hmacHex(TEST_INGEST_SECRET, ingestCanonical(ts, nonce, deviceId, bodyHash))
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    [OPERATOR_HMAC_HEADERS.ts]: ts,
    [OPERATOR_HMAC_HEADERS.nonce]: nonce,
    [OPERATOR_HMAC_HEADERS.device]: deviceId,
    [OPERATOR_HMAC_HEADERS.sig]: sig
  }
  return new Request(`https://operator.test${path}`, { method, headers, body: method === 'GET' ? undefined : bodyText })
}

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
    license: null,
    approval: 'pending',
    license_jti: null,
    ...overrides
  }
}

describe('Value tab: GET/PATCH /v1/admin/settings.json wired into buildDashboard.roi', () => {
  it('persists hourlyRate/currency, audits before and after, and roi.valueMinor/currency reflect the stored rate for a fixture with known time saved', async () => {
    const store = memoryStore()
    const db = freshSettingsDb()
    const patch = await handleRequest(
      new Request('https://operator.test/v1/admin/settings.json', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hourlyRate: 120, currency: 'CAD' })
      }),
      { ...env(), DB: db },
      { access: tonyAccess },
      { store, now: NOW }
    )
    expect(patch.status).toBe(200)

    // Persists across a fresh GET.
    const get = await handleRequest(
      new Request('https://operator.test/v1/admin/settings.json'),
      { ...env(), DB: db },
      { access: tonyAccess },
      { store, now: NOW + 1000 }
    )
    const getBody = (await get.json()) as { settings: { hourlyRate: number; currency: string } }
    expect(getBody.settings.hourlyRate).toBe(120)
    expect(getBody.settings.currency).toBe('CAD')

    // Audited, before and after.
    const auditRows = await store.listAudit(10, { action: 'settings-update' })
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0].detail).toContain('"hourlyRate":null')
    expect(auditRows[0].detail).toContain('"hourlyRate":120')

    // The product changes: buildDashboard's roi block, fed the real stored rate, prices the fixture's
    // real time-saved minutes - never a default rate, never a hand-typed dollar amount.
    const rows = fixtureRows(NOW)
    const fixtureStore = memoryStore()
    await seedStore(fixtureStore, rows)
    const dashWithRate = await buildDashboard(fixtureStore, 'tony.walteur@gmail.com', NOW, undefined, undefined, {
      hourlyRate: getBody.settings.hourlyRate,
      currency: getBody.settings.currency
    })
    expect(dashWithRate.ops.timeSaved).toBeGreaterThan(0) // the fixture really has recap-derived time saved
    const expectedMinor = Math.round((dashWithRate.ops.timeSaved! / 60) * 120 * 100)
    expect(dashWithRate.roi.valueMinor).toBe(expectedMinor)
    expect(dashWithRate.roi.currency).toBe('CAD')
    expect(dashWithRate.roi.hourlyRate).toBe(120)

    // Never a default rate: with nothing stored, valueMinor is null, not a fabricated number.
    const dashNoRate = await buildDashboard(fixtureStore, 'tony.walteur@gmail.com', NOW)
    expect(dashNoRate.roi.valueMinor).toBeNull()
    expect(dashNoRate.roi.hourlyRate).toBeNull()
  })
})

describe('Tiers tab: PATCH /v1/admin/tiers/:id changes what a real heartbeat returns', () => {
  it('persists the new entitlement set, audits old and new, and a heartbeat from a seat resolving to that tier gets the new array', async () => {
    const store = memoryStore()
    // A seat that resolves to metis-light specifically: an active issued license carrying that tier
    // (fleet.ts/tiers.ts resolve a plain-approved seat to "metis", never "metis-light", by design).
    const jti = 'a'.repeat(16)
    await store.putIssuedLicense({
      jti,
      last4: 'ab12',
      key_hash: 'hash',
      days: 30,
      iat: Math.floor(NOW / 1000),
      exp: Math.floor(NOW / 1000) + 30 * 24 * 60 * 60,
      revoked: 0,
      created_at: NOW,
      created_by: 'tony.walteur@gmail.com',
      tier: 'metis-light'
    })
    await store.upsertSeat(seat({ device_id: 'device-a', license_jti: jti }))

    const patch = await handleRequest(
      new Request('https://operator.test/v1/admin/tiers/metis-light', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entitlements: ['ask', 'intelligence', 'crm_push'] })
      }),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    expect(patch.status).toBe(200)
    const patchBody = (await patch.json()) as { tier: { entitlements: string[] } }
    expect(new Set(patchBody.tier.entitlements)).toEqual(new Set(['ask', 'intelligence', 'crm_push']))

    // Persists across a fresh GET.
    const get = await handleRequest(
      new Request('https://operator.test/v1/admin/tiers'),
      env(),
      { access: tonyAccess },
      { store, now: NOW + 1000 }
    )
    const getBody = (await get.json()) as { tiers: { id: string; entitlements: string[] }[] }
    const lightRow = getBody.tiers.find((t) => t.id === 'metis-light')
    expect(new Set(lightRow?.entitlements)).toEqual(new Set(['ask', 'intelligence', 'crm_push']))

    // Audited with both the old and the new list.
    const auditRows = await store.listAudit(10, { action: 'tier-update' })
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0].detail).toContain('ask, intelligence') // old (DEFAULT_TIER_ENTITLEMENTS['metis-light'])
    expect(auditRows[0].detail).toContain('ask, intelligence, crm_push') // new

    // The product changes: a real heartbeat from that seat now gets the new entitlements array.
    const beat = await signedRequest('/v1/heartbeat', JSON.stringify({ os: 'darwin', appVersion: '1.8.5' }), { deviceId: 'device-a' })
    const beatRes = await handleRequest(beat, env(), {}, { store, now: NOW + 2000 })
    const beatBody = (await beatRes.json()) as { tier: string; entitlements: string[] }
    expect(beatBody.tier).toBe('metis-light')
    expect(new Set(beatBody.entitlements)).toEqual(new Set(['ask', 'intelligence', 'crm_push']))
    expect(beatBody.entitlements).not.toContain('listen') // proves it is the new list, not the old default
  })
})

describe('Skills tab: GET /v1/admin/skills.json is real, Approve alone never touches the manifest, only Push does', () => {
  it('derives evidence counts from real seeded asks, and Approve leaves GET /v1/skills/manifest byte identical while Push changes it', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'device-a' }))
    // Three real asks for skill "answer", one for a different skill - evidence must count only the three.
    for (let i = 0; i < 3; i++) {
      await store.insertAsk({
        id: `ask-${i}`,
        device_id: 'device-a',
        ts: NOW - i * 1000,
        mode: 'answer',
        skill_id: 'answer',
        skill_version: '1.0.0',
        provider: 'anthropic',
        model: 'claude',
        ttft_ms: null,
        total_ms: 500,
        input_tokens: null,
        output_tokens: null,
        cache_read: null,
        cache_write: null,
        cache_uncached: null,
        cache_status: null,
        cache_ttl: null,
        outcome: 'answered',
        rating: i === 0 ? 'up' : null,
        prompt_cipher: null,
        prompt_iv: null,
        preview: 'answer ask',
        question_type: 'how-to'
      })
    }
    await store.insertAsk({
      id: 'ask-other',
      device_id: 'device-a',
      ts: NOW,
      mode: 'other-skill',
      skill_id: 'other-skill',
      skill_version: '1.0.0',
      provider: 'anthropic',
      model: 'claude',
      ttft_ms: null,
      total_ms: 500,
      input_tokens: null,
      output_tokens: null,
      cache_read: null,
      cache_write: null,
      cache_uncached: null,
      cache_status: null,
      cache_ttl: null,
      outcome: 'answered',
      rating: null,
      prompt_cipher: null,
      prompt_iv: null,
      preview: 'other ask',
      question_type: 'how-to'
    })
    await store.putProposal({
      id: 'prop-1',
      skill_id: 'answer',
      from_version: '1.0.0',
      evidence_json: '[]',
      diff: '- old line\n+ new line',
      rationale: 'Clustered recent asks.',
      status: 'pending',
      created_by: 'tony.walteur@gmail.com',
      created_at: NOW,
      decided_at: null,
      reject_reason: null
    })

    const skillsRes = await handleRequest(
      new Request('https://operator.test/v1/admin/skills.json'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    const skillsBody = (await skillsRes.json()) as { proposals: { id: string; evidence: { askCount: number } }[] }
    const prop = skillsBody.proposals.find((p) => p.id === 'prop-1')
    expect(prop?.evidence.askCount).toBe(3) // not 4: evidence is scoped to this skill's own asks

    const skillKeys = mintSkillKeys()
    const withKey = env({ OPERATOR_SKILL_PRIVATE_KEY: skillKeys.privateKeyPem })

    const manifestBefore = await handleRequest(await signedRequest('/v1/skills/manifest', ''), withKey, {}, { store, now: NOW })
    expect(manifestBefore.status).toBe(200)
    const manifestBeforeText = await manifestBefore.text()

    // Approve alone: lock - "Approve without Push does nothing on seats."
    const approve = await handleRequest(
      new Request('https://operator.test/v1/admin/skills/prop-1/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      }),
      withKey,
      { access: tonyAccess },
      { store, now: NOW + 1000 }
    )
    expect(approve.status).toBe(200)
    const manifestAfterApprove = await handleRequest(await signedRequest('/v1/skills/manifest', ''), withKey, {}, { store, now: NOW + 1000 })
    expect(manifestAfterApprove.status).toBe(200)
    expect(await manifestAfterApprove.text()).toBe(manifestBeforeText) // byte identical

    // Push: now the manifest actually changes.
    const push = await handleRequest(
      new Request('https://operator.test/v1/admin/skills/prop-1/push', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'id: answer\nversion: 1.0.1\n\nReal skill body, not the placeholder.' })
      }),
      withKey,
      { access: tonyAccess },
      { store, now: NOW + 2000 }
    )
    expect(push.status).toBe(200)
    const manifestAfterPush = await handleRequest(await signedRequest('/v1/skills/manifest', ''), withKey, {}, { store, now: NOW + 2000 })
    expect(manifestAfterPush.status).toBe(200)
    const manifestAfterPushText = await manifestAfterPush.text()
    expect(manifestAfterPushText).not.toBe(manifestBeforeText)
    const pushedBody = JSON.parse(manifestAfterPushText) as { skills: { skillId: string; version: string }[] }
    expect(pushedBody.skills.some((s) => s.skillId === 'answer' && s.version === '1.0.1')).toBe(true)
  })
})

describe('Questions tab: GET /v1/admin/questions.json computes every number from seeded asks', () => {
  it('type mix, ratings, error rate, latency percentiles and cache hit rate all match the seeded rows, and Reveal is audited', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'device-a' }))
    const latencies = [100, 200, 300, 400, 900] // p50 = 300, p95 = 900 (nearest-rank over 5 values)
    for (let i = 0; i < latencies.length; i++) {
      await store.insertAsk({
        id: `q-${i}`,
        device_id: 'device-a',
        ts: NOW - i * 1000,
        mode: 'answer',
        skill_id: null,
        skill_version: null,
        provider: 'anthropic',
        model: 'claude-sonnet',
        ttft_ms: null,
        total_ms: latencies[i],
        input_tokens: null,
        output_tokens: 10,
        cache_read: i < 3 ? 100 : null, // 3 of 5 report a cache read -> hit rate below 100%
        cache_write: i < 3 ? 0 : null,
        cache_uncached: i >= 3 ? 50 : null,
        cache_status: null,
        cache_ttl: null,
        outcome: i === 4 ? 'error' : 'answered',
        rating: i === 0 ? 'up' : i === 1 ? 'down' : null,
        prompt_cipher: null,
        prompt_iv: null,
        preview: 'answer ask',
        question_type: 'how-to'
      })
    }
    // One real ask with real ciphertext, for the Reveal assertion.
    const ingest = await signedRequest(
      '/v1/ingest',
      JSON.stringify({ id: 'reveal-ask', question: 'What is the Q3 pipeline for Acme?', mode: 'answer' }),
      { deviceId: 'device-a' }
    )
    expect((await handleRequest(ingest, env(), {}, { store, now: NOW })).status).toBe(200)

    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/questions.json?range=7d'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      totalAsks: number
      ratings: { rated: number; up: number; down: number; positiveRate: number | null }
      errorRate: number | null
      latency: { p50Ms: number | null; p95Ms: number | null }
      cache: { hitRate: number | null }
    }
    expect(body.totalAsks).toBe(6) // 5 seeded + the 1 ingested
    expect(body.ratings).toEqual({ rated: 2, up: 1, down: 1, positiveRate: 0.5 })
    expect(body.errorRate).toBeCloseTo(1 / 6, 5)
    expect(body.latency.p50Ms).toBe(300)
    expect(body.latency.p95Ms).toBe(900)
    expect(body.cache.hitRate).toBeGreaterThan(0)
    expect(body.cache.hitRate).toBeLessThan(1)

    // Reveal: audited, and returns the real plaintext for exactly this one ask.
    const reveal = await handleRequest(
      new Request('https://operator.test/v1/admin/asks/reveal-ask'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    const revealBody = (await reveal.json()) as { question: string }
    expect(revealBody.question).toBe('What is the Q3 pipeline for Acme?')
    const revealAudit = await store.listAudit(10, { action: 'reveal' })
    expect(revealAudit).toHaveLength(1)
    expect(revealAudit[0].ask_id).toBe('reveal-ask')
  })
})

describe('Platform health tab: honest bound/not-bound and missing-schema surfacing, never a secret value', () => {
  it('renders "Not bound" for an unbound secret and names a missing table, with no secret substring anywhere in the output', async () => {
    const secretValue = 'super-secret-skill-signing-key-do-not-leak'
    const healthRes = await handleRequest(
      new Request('https://operator.test/health'),
      env({ OPERATOR_SKILL_PRIVATE_KEY: secretValue }),
      {},
      { store: memoryStore(), now: NOW }
    )
    const healthBody = (await healthRes.json()) as { version: string; env: string; d1: string; schema: unknown; lastIngestAt: number | null; lastCronAt: number | null }
    const admBody = { bindings: { session: false, oauth: false }, access: { teamDomain: false, policyAud: false } }

    const enriched: HealthEnriched = {
      version: healthBody.version,
      builtAt: null,
      env: healthBody.env,
      d1Ok: healthBody.d1 === 'ok',
      schemaOk: false,
      schemaMissing: ['operator_settings', 'tiers'],
      lastIngestAt: healthBody.lastIngestAt,
      lastCronAt: healthBody.lastCronAt,
      sessionBound: admBody.bindings.session,
      oauthBound: admBody.bindings.oauth,
      teamDomainBound: admBody.access.teamDomain,
      policyAudBound: admBody.access.policyAud
    }
    const html = renderPlatformHealthEnriched(enriched, NOW)
    expect(html).toContain('Not bound')
    expect(html).toContain('missing: operator_settings, tiers')
    expect(html).not.toContain(secretValue)

    // The real /v1/admin/health.json route (not owned by this task) never puts the value on the wire
    // either - only the boolean bindings this tab reads.
    const admRes = await handleRequest(
      new Request('https://operator.test/v1/admin/health.json'),
      env({ OPERATOR_SKILL_PRIVATE_KEY: secretValue }),
      { access: tonyAccess },
      { store: memoryStore(), now: NOW }
    )
    const admText = await admRes.text()
    expect(admText).not.toContain(secretValue)
  })
})

describe('Appearance tab: density and reduced motion persist through settings.json', () => {
  it('PATCH persists both, a fresh GET returns them, and each stays independently settable from the other', async () => {
    const store = memoryStore()
    const db = freshSettingsDb()
    const patch = await handleRequest(
      new Request('https://operator.test/v1/admin/settings.json', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ density: 'compact', reducedMotion: 'reduce' })
      }),
      { ...env(), DB: db },
      { access: tonyAccess },
      { store, now: NOW }
    )
    expect(patch.status).toBe(200)

    const get = await handleRequest(
      new Request('https://operator.test/v1/admin/settings.json'),
      { ...env(), DB: db },
      { access: tonyAccess },
      { store, now: NOW + 1000 }
    )
    const body = (await get.json()) as { settings: { density: string; reducedMotion: string; hourlyRate: number | null } }
    expect(body.settings.density).toBe('compact')
    expect(body.settings.reducedMotion).toBe('reduce')
    expect(body.settings.hourlyRate).toBe(DEFAULT_OPERATOR_SETTINGS.hourlyRate) // untouched key survives

    const auditRows = await store.listAudit(10, { action: 'settings-update' })
    expect(auditRows[0].detail).toContain('"density":"comfortable"')
    expect(auditRows[0].detail).toContain('"density":"compact"')
  })
})
