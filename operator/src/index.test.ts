import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { handleRequest, type Env } from './index'
import { hmacHex } from './hmac'
import { decryptPrompt, sha256Hex, verifySkillPack } from './crypto'
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
  it('accepts a valid signature and stores ciphertext, not plaintext', async () => {
    const store = memoryStore()
    const question = 'How do I close a consulting offer this week?'
    const req = await signedRequest('/v1/ingest', JSON.stringify({
      id: 'ask-1',
      mode: 'interview',
      skillId: 'interview',
      question,
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
    expect(row?.prompt_cipher).toBeTruthy()
    expect(row?.prompt_iv).toBeTruthy()
    expect(row?.prompt_cipher).not.toContain(question)
    expect(JSON.stringify(row)).not.toContain(question)
    expect(row?.preview).not.toContain(question)
    const plain = await decryptPrompt(row!.prompt_cipher!, row!.prompt_iv!, TEST_PROMPT_KEY)
    expect(plain).toBe(question)
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
  it('returns 401 on / and /v1/admin/* when Access identity is missing, even with a valid HMAC', async () => {
    const store = memoryStore()
    const admin = await signedRequest('/v1/admin/summary', JSON.stringify({}), { method: 'GET' })
    const res = await handleRequest(admin, env(), {}, { store, now: NOW })
    expect(res.status).toBe(401)
    const home = await signedRequest('/', '', { method: 'GET' })
    expect((await handleRequest(home, env(), {}, { store, now: NOW })).status).toBe(401)
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

  it('audit-logs a reveal', async () => {
    const store = memoryStore()
    await handleRequest(
      await signedRequest('/v1/ingest', JSON.stringify({ id: 'ask-3', question: 'reveal me' })),
      env(),
      {},
      { store, now: NOW }
    )
    const reveal = await handleRequest(
      new Request('https://operator.test/v1/admin/asks/ask-3'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    expect(reveal.status).toBe(200)
    const body = (await reveal.json()) as { question?: string }
    expect(body.question).toBe('reveal me')
    const audit = await store.listAudit(5)
    expect(audit.some((a) => a.action === 'reveal' && a.actor === 'tony.walteur@gmail.com' && a.ask_id === 'ask-3')).toBe(
      true
    )
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
})
