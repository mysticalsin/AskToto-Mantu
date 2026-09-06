import { describe, expect, it } from 'vitest'
import { handleRequest, type Env } from '../index'
import { memoryStore, type AskRow, type PackRow, type ProposalRow } from '../store'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY } from '../test-fixtures'

const NOW = 1_725_000_000_000
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

function env(): Env {
  return { OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET, OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY, OPERATOR_SKILL_PRIVATE_KEY: '' }
}

const tonyAccess = { getIdentity: async () => ({ email: 'tony.walteur@gmail.com' }) }
const noAccess = { getIdentity: async () => null }

async function get(path: string, store: ReturnType<typeof memoryStore>, access = tonyAccess) {
  return handleRequest(new Request(`https://operator.test${path}`), env(), { access }, { store, now: NOW })
}

function ask(overrides: Partial<AskRow> & Pick<AskRow, 'id' | 'device_id'>): AskRow {
  return {
    ts: NOW - 30_000,
    mode: 'answer',
    skill_id: null,
    skill_version: null,
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    ttft_ms: null,
    total_ms: null,
    input_tokens: null,
    output_tokens: null,
    cache_read: null,
    cache_write: null,
    cache_uncached: null,
    cache_status: null,
    cache_ttl: null,
    outcome: 'answered',
    rating: null,
    prompt_cipher: 'super-secret-ciphertext',
    prompt_iv: 'iv-value',
    preview: 'this is the confidential prompt preview text nobody should see here',
    question_type: 'factual',
    ...overrides
  }
}

function proposal(overrides: Partial<ProposalRow> & Pick<ProposalRow, 'id' | 'skill_id'>): ProposalRow {
  return {
    from_version: '1.0.0',
    evidence_json: '[]',
    diff: '# unified diff against x v1.0.0\n# Edit, then Approve. Push is a separate click.\n',
    rationale: 'Clustered 3 recent Asks in answer.',
    status: 'pending',
    created_by: 'tony.walteur@gmail.com',
    created_at: NOW - DAY,
    decided_at: null,
    reject_reason: null,
    ...overrides
  }
}

function pack(overrides: Partial<PackRow> & Pick<PackRow, 'id' | 'skill_id'>): PackRow {
  return {
    version: '1.1.0',
    sha256: 'a'.repeat(64),
    body: 'skill body',
    signed: 'signature',
    pushed_at: NOW - DAY,
    pushed_by: 'tony.walteur@gmail.com',
    ...overrides
  }
}

describe('GET /v1/admin/questions.json', () => {
  it('requires admin auth', async () => {
    const res = await get('/v1/admin/questions.json', memoryStore(), noAccess)
    expect(res.status).toBe(401)
  })

  it('reports an honest empty state with no asks in range', async () => {
    const res = await get('/v1/admin/questions.json?range=7d', memoryStore())
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.ok).toBe(true)
    expect(body.range).toBe('7d')
    expect(body.totalAsks).toBe(0)
    expect(body.mix.total).toBe(0)
    expect(body.coverage).toBeNull()
    expect(body.ratings).toEqual({ rated: 0, up: 0, down: 0, positiveRate: null })
    expect(body.errorRate).toBeNull()
    expect(body.latency).toEqual({ p50Ms: null, p95Ms: null, sampleSize: 0 })
    expect(body.cache.hitRate).toBeNull()
    expect(body.providers).toEqual([])
    expect(body.models).toEqual([])
    expect(body.cost).toBeNull()
    expect(body.needsAttention).toEqual([])
  })

  it('defaults to the 7 day range on an unrecognised or missing range param', async () => {
    const res1 = await get('/v1/admin/questions.json', memoryStore())
    expect(((await res1.json()) as any).range).toBe('7d')
    const res2 = await get('/v1/admin/questions.json?range=90d', memoryStore())
    expect(((await res2.json()) as any).range).toBe('7d')
  })

  it('computes the type mix, coverage, ratings, error rate, latency and providers from real asks, and excludes asks outside the range', async () => {
    const store = memoryStore()
    await store.insertAsk(ask({ id: 'a1', device_id: 'd1', question_type: 'code', mode: 'answer', rating: 'up', total_ms: 100 }))
    await store.insertAsk(ask({ id: 'a2', device_id: 'd2', question_type: 'code', mode: 'answer', rating: 'down', outcome: 'error', total_ms: 300 }))
    await store.insertAsk(ask({ id: 'a3', device_id: 'd3', question_type: 'factual', mode: 'answer', provider: 'openai', total_ms: 200 }))
    await store.insertAsk(ask({ id: 'a4', device_id: 'd4', question_type: null, mode: 'listen', total_ms: null }))
    // Outside the 7d window entirely -- must not leak into the 7d totals.
    await store.insertAsk(ask({ id: 'old', device_id: 'd5', ts: NOW - 40 * DAY, question_type: 'code' }))

    const res = await get('/v1/admin/questions.json?range=7d', store)
    const body = (await res.json()) as any
    expect(body.totalAsks).toBe(4)
    expect(body.mix.classified).toBe(3) // a4's null type does not count as classified
    expect(body.mix.total).toBe(4)
    expect(body.coverage).toBeCloseTo(0.75)
    const codeBar = body.mix.bars.find((b: any) => b.type === 'code')
    expect(codeBar.count).toBe(2)

    expect(body.ratings).toEqual({ rated: 2, up: 1, down: 1, positiveRate: 0.5 })
    expect(body.errorRate).toBeCloseTo(0.25)
    expect(body.latency.sampleSize).toBe(3)
    expect(body.latency.p50Ms).toBe(200)

    const providerKeys = body.providers.map((p: any) => p.key)
    expect(providerKeys).toContain('anthropic')
    expect(providerKeys).toContain('openai')

    const byModeAnswer = body.byMode.find((m: any) => m.mode === 'answer')
    expect(byModeAnswer.count).toBe(3)
    expect(byModeAnswer.ratings).toEqual({ up: 1, down: 1 })
  })

  it('lists the errored and downvoted asks as needs-attention, newest first, with a real seat label, and never the prompt preview text', async () => {
    const store = memoryStore()
    await store.upsertSeat({
      device_id: 'd1',
      seat_hash: 'h',
      os: 'darwin',
      app_version: '1.0.0',
      first_seen: NOW - DAY,
      last_seen: NOW,
      country: 'CA',
      city: 'Montreal',
      lat: null,
      lon: null,
      last_index_at: null,
      hostname: 'Tonys-Mac',
      sso_email: null,
      license: null
    })
    await store.insertAsk(ask({ id: 'ok', device_id: 'd1', ts: NOW - 5000, outcome: 'answered', rating: 'up' }))
    await store.insertAsk(ask({ id: 'bad-old', device_id: 'd1', ts: NOW - 4000, outcome: 'error' }))
    await store.insertAsk(ask({ id: 'bad-new', device_id: 'd1', ts: NOW - 1000, rating: 'down' }))

    const res = await get('/v1/admin/questions.json?range=7d', store)
    const body = (await res.json()) as any
    expect(body.needsAttention.map((r: any) => r.id)).toEqual(['bad-new', 'bad-old'])
    expect(body.needsAttention[0].seat).toBe('Tonys-Mac')

    const raw = JSON.stringify(body)
    expect(raw).not.toContain('confidential prompt preview text')
    expect(raw).not.toContain('super-secret-ciphertext')
  })
})

describe('GET /v1/admin/skills.json', () => {
  it('requires admin auth', async () => {
    const res = await get('/v1/admin/skills.json', memoryStore(), noAccess)
    expect(res.status).toBe(401)
  })

  it('reports an honest empty state with no proposals or packs', async () => {
    const res = await get('/v1/admin/skills.json', memoryStore())
    const body = (await res.json()) as any
    expect(body.ok).toBe(true)
    expect(body.proposals).toEqual([])
    expect(body.history).toEqual([])
  })

  it('computes evidence for a proposal from recent asks matching its skill id, never raw text', async () => {
    const store = memoryStore()
    await store.putProposal(proposal({ id: 'p1', skill_id: 'answer' }))
    await store.insertAsk(ask({ id: 'a1', device_id: 'd1', mode: 'answer', question_type: 'code', rating: 'up' }))
    await store.insertAsk(ask({ id: 'a2', device_id: 'd2', mode: 'answer', question_type: 'code', rating: 'down' }))
    await store.insertAsk(ask({ id: 'a3', device_id: 'd3', mode: 'other', question_type: 'factual' }))

    const res = await get('/v1/admin/skills.json', store)
    const body = (await res.json()) as any
    expect(body.proposals).toHaveLength(1)
    const p = body.proposals[0]
    expect(p.skillId).toBe('answer')
    expect(p.evidence.askCount).toBe(2)
    expect(p.evidence.ratings).toEqual({ up: 1, down: 1 })
    expect(p.evidence.topTypes[0].type).toBe('code')
    expect(JSON.stringify(body)).not.toContain('confidential prompt preview text')
  })

  it('lists pushed packs newest first with pulledBySeats from each seat’s most recent ask on that exact version', async () => {
    const store = memoryStore()
    await store.putPack(pack({ id: 'pack1', skill_id: 'answer', version: '1.0.0', pushed_at: NOW - 2 * DAY }))
    await store.putPack(pack({ id: 'pack2', skill_id: 'answer', version: '1.1.0', pushed_at: NOW - DAY }))
    // d1's most recent ask is on 1.1.0 -- counts toward pack2, not pack1.
    await store.insertAsk(ask({ id: 'a1', device_id: 'd1', ts: NOW - 3 * DAY, skill_id: 'answer', skill_version: '1.0.0' }))
    await store.insertAsk(ask({ id: 'a2', device_id: 'd1', ts: NOW - HOUR, skill_id: 'answer', skill_version: '1.1.0' }))
    // d2 never moved past 1.0.0.
    await store.insertAsk(ask({ id: 'a3', device_id: 'd2', ts: NOW - HOUR, skill_id: 'answer', skill_version: '1.0.0' }))

    const res = await get('/v1/admin/skills.json', store)
    const body = (await res.json()) as any
    expect(body.history.map((h: any) => h.id)).toEqual(['pack2', 'pack1'])
    expect(body.history.find((h: any) => h.id === 'pack1').pulledBySeats).toBe(1)
    expect(body.history.find((h: any) => h.id === 'pack2').pulledBySeats).toBe(1)
  })
})
