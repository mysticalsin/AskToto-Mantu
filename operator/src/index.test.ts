import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { handleRequest, type Env } from './index'
import { hmacHex } from './hmac'
import { sha256Hex, verifySkillPack } from './crypto'
import { ingestCanonical, OPERATOR_HMAC_HEADERS } from '../../src/shared/operator-hmac'
import { memoryStore } from './store'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY } from './test-fixtures'

const NOW = 1_725_000_000_000

function mintSkillKeys(): { privateKeyPem: string; publicKeyRaw: string } {
  const pair = generateKeyPairSync('ed25519')
  const jwk = pair.publicKey.export({ format: 'jwk' }) as { x?: string }
  if (typeof jwk.x !== 'string' || !jwk.x) throw new Error('ed25519 jwk missing x')
  return {
    privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyRaw: jwk.x
  }
}

const SKILL_KEYS = mintSkillKeys()

function env(overrides: Partial<Env> = {}): Env {
  return {
    OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET,
    OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY,
    OPERATOR_SKILL_PRIVATE_KEY: SKILL_KEYS.privateKeyPem,
    ...overrides
  }
}

const tonyAccess = {
  getIdentity: async () => ({ email: 'tony.walteur@gmail.com' })
}

async function signedRequest(
  path: string,
  bodyText: string,
  opts: { ts?: number; nonce?: string; deviceId?: string; sig?: string | null; method?: string } = {}
): Promise<Request> {
  const ts = String(opts.ts ?? NOW)
  const nonce = opts.nonce ?? `nonce-${Math.random().toString(16).slice(2)}`
  const deviceId = opts.deviceId ?? 'device-a'
  const bodyHash = await sha256Hex(bodyText)
  const sig =
    opts.sig === null
      ? ''
      : (opts.sig ?? (await hmacHex(TEST_INGEST_SECRET, ingestCanonical(ts, nonce, deviceId, bodyHash))))
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    [OPERATOR_HMAC_HEADERS.ts]: ts,
    [OPERATOR_HMAC_HEADERS.nonce]: nonce,
    [OPERATOR_HMAC_HEADERS.device]: deviceId
  }
  if (sig) headers[OPERATOR_HMAC_HEADERS.sig] = sig
  return new Request(`https://operator.test${path}`, {
    method: opts.method ?? (path.includes('manifest') ? 'GET' : 'POST'),
    headers,
    body: opts.method === 'GET' || path.includes('manifest') ? undefined : bodyText
  })
}

describe('HMAC ingest', () => {
  it('accepts a valid legacy Ask but stores only approved metadata, never question content or ciphertext', async () => {
    const store = memoryStore()
    const question = 'How do I close a consulting offer this week?'
    const req = await signedRequest('/v1/ingest', JSON.stringify({
      id: 'ask-1',
      mode: 'private customer strategy',
      skillId: 'interview',
      question,
      questionType: 'how-to',
      cacheRead: 800,
      cacheWrite: 200,
      cacheUncached: 40,
      cacheStatus: 'hit',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6'
    }))
    const res = await handleRequest(req, env(), {}, { store, now: NOW })
    expect(res.status).toBe(200)
    const row = await store.getAsk('ask-1')
    expect(row).toBeTruthy()
    expect(row?.prompt_cipher).toBeNull()
    expect(row?.prompt_iv).toBeNull()
    expect(JSON.stringify(row)).not.toContain(question)
    expect(row?.mode).toBeNull()
    expect(row?.preview).toBe('Ask · How to')
    expect(row).toMatchObject({
      id: 'ask-1',
      skill_id: 'interview',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      cache_read: 800,
      cache_write: 200,
      cache_uncached: 40,
      cache_status: 'hit',
      question_type: 'how-to'
    })
  })

  it('rejects a bad signature', async () => {
    const store = memoryStore()
    const req = await signedRequest('/v1/ingest', JSON.stringify({ id: 'x' }), { sig: 'ab'.repeat(32) })
    const res = await handleRequest(req, env(), {}, { store, now: NOW })
    expect(res.status).toBe(401)
    expect(await store.getAsk('x')).toBeNull()
  })

  it('rejects timestamp skew over 5 minutes', async () => {
    const store = memoryStore()
    const req = await signedRequest('/v1/ingest', JSON.stringify({ id: 'skew' }), { ts: NOW - 6 * 60 * 1000 })
    const res = await handleRequest(req, env(), {}, { store, now: NOW })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toMatch(/skew/)
  })

  it('rejects a missing nonce', async () => {
    const store = memoryStore()
    const req = await signedRequest('/v1/ingest', JSON.stringify({ id: 'n' }), { nonce: '' })
    const res = await handleRequest(req, env(), {}, { store, now: NOW })
    expect(res.status).toBe(401)
  })

  it('rejects a replayed nonce', async () => {
    const store = memoryStore()
    const body = JSON.stringify({ id: 'replay' })
    const first = await signedRequest('/v1/ingest', body, { nonce: 'once' })
    expect((await handleRequest(first, env(), {}, { store, now: NOW })).status).toBe(200)
    const second = await signedRequest('/v1/ingest', body, { nonce: 'once' })
    expect((await handleRequest(second, env(), {}, { store, now: NOW })).status).toBe(401)
  })
})

describe('Access on admin routes', () => {
  it('returns 401 JSON on /v1/admin/* when identity is missing, even with a valid HMAC', async () => {
    const store = memoryStore()
    const admin = await signedRequest('/v1/admin/summary', JSON.stringify({}), { method: 'GET' })
    const res = await handleRequest(admin, env(), {}, { store, now: NOW })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ ok: false, error: 'Access required' })
    const homeJson = new Request('https://operator.test/', { headers: { accept: 'application/json' } })
    const home = await handleRequest(
      homeJson,
      { ...env(), TEAM_DOMAIN: 'https://tony-walteur.cloudflareaccess.com' },
      {},
      { store, now: NOW }
    )
    expect(home.status).toBe(302)
    expect(home.headers.get('location') || '').toMatch(/login/i)
    const postKeys = await handleRequest(
      new Request('https://operator.test/v1/admin/keys', { method: 'POST', body: '{}' }),
      env(),
      {},
      { store, now: NOW }
    )
    expect(postKeys.status).toBe(401)
  })

  it('rejects a non-allowlisted Access email', async () => {
    const store = memoryStore()
    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/summary'),
      env(),
      { access: { getIdentity: async () => ({ email: 'other@example.com' }) } },
      { store, now: NOW }
    )
    expect(res.status).toBe(401)
  })

  it('allows Tony and never returns prompt ciphertext on the asks list', async () => {
    const store = memoryStore()
    await handleRequest(
      await signedRequest('/v1/ingest', JSON.stringify({ id: 'ask-2', question: 'secret close plan', mode: 'sales' })),
      env(),
      {},
      { store, now: NOW }
    )
    const list = await handleRequest(
      new Request('https://operator.test/v1/admin/asks'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    expect(list.status).toBe(200)
    const body = (await list.json()) as { asks: { prompt_cipher?: string; question?: string }[] }
    expect(body.asks[0]?.prompt_cipher).toBeUndefined()
    expect(body.asks[0]?.question).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain('secret close plan')
  })

  it('refuses legacy Ask reveal without decrypting stored ciphertext', async () => {
    const store = memoryStore()
    await store.insertAsk({
      id: 'ask-3', device_id: 'device-a', ts: NOW, mode: 'answer', skill_id: null, skill_version: null,
      provider: 'anthropic', model: 'claude', ttft_ms: null, total_ms: null, input_tokens: null,
      output_tokens: null, cache_read: null, cache_write: null, cache_uncached: null, cache_status: null,
      cache_ttl: null, outcome: null, rating: null, prompt_cipher: 'legacy-ciphertext', prompt_iv: 'legacy-iv',
      preview: 'legacy private question', question_type: 'factual', path_tag: null
    })
    const reveal = await handleRequest(
      new Request('https://operator.test/v1/admin/asks/ask-3'),
      env({ OPERATOR_PROMPT_KEY: '' }),
      { access: tonyAccess },
      { store, now: NOW }
    )
    expect(reveal.status).toBe(410)
    expect(await reveal.json()).toEqual({ ok: false, error: 'Ask content is unavailable' })
    const audit = await store.listAudit(5)
    expect(audit.some((a) => a.action === 'reveal')).toBe(false)
  })
})

describe('Approve vs Push', () => {
  it('Approve does not publish a pack; Push signs a verifiable pack', async () => {
    const store = memoryStore()
    const draft = await handleRequest(
      new Request('https://operator.test/v1/admin/skills/draft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ skillId: 'interview' })
      }),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    const { id } = (await draft.json()) as { id: string }
    const skillMd = `---\nid: interview\nversion: 1.1.1\nlocked: true\n---\n\nStay the candidate. Humanizer stays.\n`
    const approve = await handleRequest(
      new Request(`https://operator.test/v1/admin/skills/${id}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ diff: skillMd })
      }),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    expect(approve.status).toBe(200)
    expect(((await approve.json()) as { pushed?: boolean }).pushed).toBe(false)
    expect((await store.latestPacks()).length).toBe(0)

    const push = await handleRequest(
      new Request(`https://operator.test/v1/admin/skills/${id}/push`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      }),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    expect(push.status).toBe(200)
    const pushed = (await push.json()) as { pushed?: boolean; signed?: string }
    expect(pushed.pushed).toBe(true)
    expect(pushed.signed).toBeTruthy()
    const verified = await verifySkillPack(pushed.signed!, SKILL_KEYS.publicKeyRaw)
    expect(verified?.skillId).toBe('interview')
    expect(verified?.body).toContain('Stay the candidate')
    expect((await store.latestPacks()).length).toBe(1)
  })
})

describe('health', () => {
  it('does not require Access or HMAC', async () => {
    const res = await handleRequest(new Request('https://operator.test/health'), env(), {}, { store: memoryStore() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { service?: string }
    expect(body.service).toBe('metis-operator')
  })

  it('reports schema unbound and lastIngestAt/lastCronAt from D1-free store data (task B6)', async () => {
    const store = memoryStore()
    await store.upsertSeat({
      device_id: 'dev-a',
      seat_hash: 'h',
      os: 'darwin',
      app_version: '1.8.5',
      first_seen: NOW - 1000,
      last_seen: NOW - 1000,
      country: 'CA',
      city: null,
      region: null,
      lat: null,
      lon: null,
      last_index_at: null,
      hostname: 'box',
      sso_email: 'tony.walteur@gmail.com',
      license: 'approved',
      approval: 'approved',
      license_jti: null
    })
    await store.audit('a-1', NOW - 500, 'system', 'platform.heartbeat', null, 'events 0')
    const res = await handleRequest(new Request('https://operator.test/health'), env(), {}, { store, now: NOW })
    const body = (await res.json()) as { d1: string; schema: string; lastIngestAt: number | null; lastCronAt: number | null }
    expect(body.d1).toBe('unbound')
    expect(body.schema).toBe('unbound')
    expect(body.lastIngestAt).toBe(NOW - 1000)
    expect(body.lastCronAt).toBe(NOW - 500)
  })

  it('never exposes a secret or a binding value', async () => {
    const res = await handleRequest(new Request('https://operator.test/health'), env(), {}, { store: memoryStore() })
    const text = await res.text()
    expect(text).not.toContain(TEST_INGEST_SECRET)
    expect(text).not.toContain(TEST_PROMPT_KEY)
  })
})

describe('packed console map and geo', () => {
  it('renders an empty map when there are no heartbeats, never sample visitors', async () => {
    const store = memoryStore()
    const home = await handleRequest(
      new Request('https://operator.test/'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    expect(home.status).toBe(200)
    const page = await home.text()
    expect(page).toContain('No heartbeats yet. The map stays empty until a seat checks in.')
    // The inlined world land carries thousands of SVG coordinate pairs ("L1,344"); strip the
    // vector markup before checking the copy for sample numbers.
    const prose = page.replace(/<svg[\s\S]*?<\/svg>/g, '')
    expect(prose).not.toMatch(/Unique Visitors|visitor traffic|\$6,525|1,344/)
    expect(prose).not.toMatch(/\b1\.2\.3\.4\b/)
    const dash = await handleRequest(
      new Request('https://operator.test/v1/admin/dashboard'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    const body = (await dash.json()) as { map: { empty: boolean; countries: unknown[]; dots: unknown[] } }
    expect(body.map.empty).toBe(true)
    expect(body.map.countries).toEqual([])
    expect(body.map.dots).toEqual([])
  })

  it('stores Cloudflare cf geo on heartbeat and ignores client coordinates and IP', async () => {
    const store = memoryStore()
    const req = await signedRequest(
      '/v1/heartbeat',
      JSON.stringify({
        os: 'darwin',
        appVersion: '1.8.0',
        lat: 9,
        lon: 9,
        country: 'US',
        city: 'Clientville',
        ip: '203.0.113.9'
      })
    )
    const res = await handleRequest(req, env(), {}, {
      store,
      now: NOW,
      geo: { country: 'FR', city: 'Paris', lat: 48.857, lon: 2.351 }
    })
    expect(res.status).toBe(200)
    const seats = await store.listSeats()
    expect(seats[0]?.country).toBe('FR')
    expect(seats[0]?.city).toBe('Paris')
    expect(seats[0]?.lat).toBe(48.857)
    expect(seats[0]?.lon).toBe(2.351)
    const dash = await handleRequest(
      new Request('https://operator.test/v1/admin/dashboard'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    const text = await dash.text()
    expect(text).not.toContain('203.0.113.9')
    expect(text).not.toContain('Clientville')
    const body = JSON.parse(text) as {
      map: { empty: boolean; countries: { iso: string; devices: number }[] }
      scale: { hours24: { heartbeats: number }[] }
    }
    expect(body.map.empty).toBe(false)
    expect(body.map.countries).toEqual([{ iso: 'FR', devices: 1 }])
    expect(body.scale.hours24.at(-1)?.heartbeats).toBe(1)
  })

  it('leaves the map empty when the Worker has no request.cf', async () => {
    const store = memoryStore()
    const req = await signedRequest('/v1/heartbeat', JSON.stringify({ os: 'win', appVersion: '1.8.0' }))
    expect((await handleRequest(req, env(), {}, { store, now: NOW })).status).toBe(200)
    const dash = await handleRequest(
      new Request('https://operator.test/v1/admin/dashboard'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    const body = (await dash.json()) as { map: { empty: boolean; countries: unknown[] }; kpis: { live: number } }
    expect(body.kpis.live).toBe(1)
    expect(body.map.empty).toBe(true)
    expect(body.map.countries).toEqual([])
  })
})

describe('CRM send board', () => {
  it('funnel counts are real rows; Retry on Failed does not auto-send', async () => {
    const store = memoryStore()
    const ingest = await signedRequest(
      '/v1/ingest',
      JSON.stringify({
        event: 'crm',
        id: 'crm-1',
        status: 'failed',
        title: 'Acme recap',
        connector: 'bidstack'
      })
    )
    expect((await handleRequest(ingest, env(), {}, { store, now: NOW })).status).toBe(200)
    const dash = await handleRequest(
      new Request('https://operator.test/v1/admin/dashboard'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    const before = (await dash.json()) as {
      crm: { counts: Record<string, number>; rows: { status: string }[]; landing: { deadLetters: number } }
    }
    expect(before.crm.counts.failed).toBe(1)
    expect(before.crm.rows[0]?.status).toBe('failed')
    const retry = await handleRequest(
      new Request('https://operator.test/v1/admin/crm/crm-1/retry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    expect(retry.status).toBe(200)
    expect(((await retry.json()) as { autoSend?: boolean }).autoSend).toBe(false)
    const row = await store.getCrm('crm-1')
    expect(row?.status).toBe('pending')
    expect(row?.retry_requested).toBe(1)
  })

  it('confidential CRM events are not ingested', async () => {
    const store = memoryStore()
    const ingest = await signedRequest(
      '/v1/ingest',
      JSON.stringify({
        event: 'crm',
        id: 'secret-1',
        status: 'success',
        title: 'Confidential recap',
        connector: 'clickup',
        confidential: true
      })
    )
    const res = await handleRequest(ingest, env(), {}, { store, now: NOW })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { ingested?: boolean }).ingested).toBe(false)
    expect(await store.getCrm('secret-1')).toBeNull()
  })

  it('stores only canonical CRM delivery metadata and clears legacy content-bearing columns', async () => {
    const store = memoryStore()
    await store.upsertCrm({
      id: 'crm-ok', device_id: 'device-a', ts: NOW - 1, status: 'pending', title: 'Legacy Customer Alpha',
      connector: 'plane', meeting_file: '/legacy/private.md', meeting_hash: 'aabbccddeeff0011',
      last_error: 'Legacy customer error text', retry_requested: 0, attempt: 1, latency_ms: 10,
      remote_id: 'legacy-deal', remote_url: 'https://crm.example/legacy-deal', action: 'legacy-action'
    })
    const ingest = await signedRequest(
      '/v1/ingest',
      JSON.stringify({
        event: 'crm',
        id: 'crm-ok',
        status: 'success',
        title: 'Acme recap',
        connector: 'plane',
        meetingHash: 'aabbccddeeff0011',
        remoteId: 'deal-99',
        remoteUrl: 'https://crm.example/deal-99',
        meetingFile: '/Users/tony/secret/Acme.md',
        error: 'timeout posting Customer Alpha to https://crm.example/deal-99',
        attempt: 2,
        latencyMs: 345
      })
    )
    expect((await handleRequest(ingest, env(), {}, { store, now: NOW })).status).toBe(200)
    const row = await store.getCrm('crm-ok')
    expect(row).toMatchObject({
      id: 'crm-ok', status: 'success', title: 'CRM delivery', connector: 'plane', last_error: 'transient',
      retry_requested: 0, attempt: 2, latency_ms: 345, meeting_file: null, meeting_hash: null,
      remote_id: null, remote_url: null, action: null
    })
    expect(JSON.stringify(row)).not.toContain('Customer Alpha')
    expect(JSON.stringify(row)).not.toContain('deal-99')
    const dash = await handleRequest(
      new Request('https://operator.test/v1/admin/dashboard'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    const body = (await dash.json()) as { crm: { rows: { title: string; error: string; remoteId: string | null; meetingHash: string | null }[] } }
    expect(body.crm.rows[0]).toMatchObject({ title: 'CRM delivery', error: 'transient', remoteId: null, meetingHash: null })
    expect(JSON.stringify(body)).not.toContain('/Users/tony')
  })

  it('projects heartbeat CRM and event detail without path, text, or CRM content', async () => {
    const store = memoryStore()
    const privatePath = '/Users/tony/Customer Alpha/private-meeting.md'
    const privateText = 'Customer Alpha acquisition plan'
    const req = await signedRequest('/v1/heartbeat', JSON.stringify({
      os: 'darwin', appVersion: '2.0.0', path: privatePath, text: privateText,
      crm: [{
        event: 'crm', id: 'crm-heartbeat', status: 'failed', connector: 'hubspot',
        title: privateText, error: `timeout ${privateText}`, remoteId: 'customer-alpha-42',
        remoteUrl: 'https://crm.example/customer-alpha-42', meetingHash: 'aabbccddeeff0011', action: 'send-private'
      }]
    }))
    expect((await handleRequest(req, env(), {}, { store, now: NOW })).status).toBe(200)

    const crm = await store.getCrm('crm-heartbeat')
    expect(crm).toMatchObject({
      status: 'failed', title: 'CRM delivery', connector: 'hubspot', last_error: 'transient',
      meeting_hash: null, remote_id: null, remote_url: null, action: null
    })
    const events = await store.listEvents(10)
    const persisted = JSON.stringify({ crm, events })
    expect(persisted).not.toContain(privatePath)
    expect(persisted).not.toContain(privateText)
    expect(events.find((event) => event.kind === 'heartbeat')?.detail).toBeNull()
  })

  it('Retry does not fire without Access', async () => {
    const store = memoryStore()
    const ingest = await signedRequest(
      '/v1/ingest',
      JSON.stringify({ event: 'crm', id: 'crm-1', status: 'failed', title: 'Acme', connector: 'bidstack' })
    )
    expect((await handleRequest(ingest, env(), {}, { store, now: NOW })).status).toBe(200)
    const retry = await handleRequest(
      new Request('https://operator.test/v1/admin/crm/crm-1/retry', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      }),
      env(),
      {},
      { store, now: NOW }
    )
    expect(retry.status).toBe(401)
    expect((await store.getCrm('crm-1'))?.retry_requested).toBe(0)
  })

  it('Access Retry puts the id on the next heartbeat pull', async () => {
    const store = memoryStore()
    const ingest = await signedRequest(
      '/v1/ingest',
      JSON.stringify({ event: 'crm', id: 'crm-1', status: 'failed', title: 'Acme', connector: 'bidstack' })
    )
    expect((await handleRequest(ingest, env(), {}, { store, now: NOW })).status).toBe(200)
    await handleRequest(
      new Request('https://operator.test/v1/admin/crm/crm-1/retry', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      }),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    const beat = await signedRequest('/v1/heartbeat', JSON.stringify({ os: 'darwin', appVersion: '1.8.0' }))
    const res = await handleRequest(beat, env(), {}, { store, now: NOW })
    expect(((await res.json()) as { retry?: string[] }).retry).toEqual(['crm-1'])
  })

  it('a CRM row id containing a tab and =cmd never lands a control character in the crm-retry audit detail (security review, defence in depth)', async () => {
    // Ingest already sanitises body.id (deviceSuppliedId strips control characters); this test goes
    // straight through the store, the way a row written before that sanitiser existed - or by any
    // future write path this handler cannot see - would still look. safeAuditText at the crm-retry
    // audit call site is the second, independent layer that must catch it regardless.
    const store = memoryStore()
    const trickyId = 'crm-1\t=cmd(A1)'
    await store.upsertCrm({
      id: trickyId,
      device_id: 'device-a',
      ts: NOW,
      status: 'failed',
      title: 'Acme recap',
      connector: 'bidstack',
      meeting_file: null,
      meeting_hash: null,
      last_error: null,
      retry_requested: 0,
      attempt: 0,
      latency_ms: 0,
      remote_id: null,
      remote_url: null,
      action: null
    })
    const retry = await handleRequest(
      new Request(`https://operator.test/v1/admin/crm/${encodeURIComponent(trickyId)}/retry`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      }),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    expect(retry.status).toBe(200)
    const auditRows = await store.listAudit(10, { action: 'crm-retry' })
    expect(auditRows).toHaveLength(1)
    // eslint-disable-next-line no-control-regex
    expect(auditRows[0].detail).not.toMatch(/[\t\r\n\x00-\x1f\x7f]/)
    expect(auditRows[0].detail).toContain('crm-1 =cmd(A1)')
  })

  it('console HTML uses StatusBadge, Retry on Failed, and no StatusDemo', async () => {
    const store = memoryStore()
    for (const status of ['pending', 'in_progress', 'in_review', 'submitted', 'success', 'failed', 'expired']) {
      const ingest = await signedRequest(
        '/v1/ingest',
        JSON.stringify({
          event: 'crm',
          id: `row-${status}`,
          status,
          title: `${status} send`,
          connector: 'clickup',
          ...(status === 'success' ? { remoteId: 'cu-1' } : {})
        }),
        { nonce: `n-${status}` }
      )
      expect((await handleRequest(ingest, env(), {}, { store, now: NOW })).status).toBe(200)
    }
    const page = await handleRequest(new Request('https://operator.test/'), env(), { access: tonyAccess }, { store, now: NOW })
    const html = await page.text()
    expect(html).toContain('data-retry="row-failed"')
    expect(html).toContain('data-retry="row-expired"')
    expect(html).toContain('data-status="failed"')
    expect(html).toContain('status-badge')
    expect(html).toContain('Submitted')
    expect([...html.matchAll(/data-crm-filter="([^"]+)"/g)].map((m) => m[1])).toEqual([
      'all',
      'pending',
      'failed',
      'success',
      'in_progress',
      'in_review',
      'expired',
      'submitted'
    ])
    expect(html).toContain('Data-push telemetry')
    expect(html).not.toContain('Submited')
    expect(html).not.toContain('StatusDemo')
    expect(html).not.toContain('bg-orange-50')
    expect(html).not.toContain('unsplash')
    expect(html).not.toContain('Unsplash')
  })
})
