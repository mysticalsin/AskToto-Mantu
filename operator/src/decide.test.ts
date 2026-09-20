import { describe, expect, it } from 'vitest'
import { handleRequest, type Env } from './index'
import { hmacHex } from './hmac'
import { sha256Hex } from './crypto'
import { ingestCanonical, OPERATOR_HMAC_HEADERS } from '../../src/shared/operator-hmac'
import { memoryStore } from './store'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY, TEST_VAULT_KEY } from './test-fixtures'
import {
  VAULT_DECISION_PROVIDERS,
  VAULT_LLM_PROVIDERS,
  TYPESAFE_JEV_PROVIDER,
  isVaultDecisionProvider,
  isVaultLlmProvider
} from './vault'
import { decisionProvidersForSeat } from './decide'

const NOW = 1_725_000_000_000
const DEVICE = 'device-decide'

function env(): Env {
  return {
    OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET,
    OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY,
    OPERATOR_SKILL_PRIVATE_KEY: 'unused',
    OPERATOR_VAULT_KEY: TEST_VAULT_KEY
  }
}

const tony = { getIdentity: async () => ({ email: 'tony.walteur@gmail.com' }) }

async function signedRequest(path: string, bodyText: string, nonce = `decide-${Math.random().toString(16).slice(2)}`) {
  const ts = String(NOW)
  const sig = await hmacHex(TEST_INGEST_SECRET, ingestCanonical(ts, nonce, DEVICE, await sha256Hex(bodyText)))
  return new Request(`https://operator.test${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [OPERATOR_HMAC_HEADERS.ts]: ts,
      [OPERATOR_HMAC_HEADERS.nonce]: nonce,
      [OPERATOR_HMAC_HEADERS.device]: DEVICE,
      [OPERATOR_HMAC_HEADERS.sig]: sig
    },
    body: bodyText
  })
}

async function approveDevice(store: ReturnType<typeof memoryStore>) {
  await store.upsertSeat({
    device_id: DEVICE,
    seat_hash: DEVICE,
    os: 'darwin',
    app_version: '1.9.1',
    first_seen: NOW,
    last_seen: NOW,
    country: 'CA',
    city: 'Toronto',
    lat: 43.7,
    lon: -79.4,
    last_index_at: null,
    hostname: 'test-host',
    sso_email: 'tony.walteur@gmail.com',
    license: 'licensed',
    approval: 'approved'
  })
}

describe('Cap1 decision vault separation', () => {
  it('keeps typesafe_jev out of VAULT_LLM_PROVIDERS', () => {
    expect(VAULT_DECISION_PROVIDERS).toContain('typesafe_jev')
    expect(VAULT_LLM_PROVIDERS).not.toContain('typesafe_jev')
    expect(isVaultDecisionProvider(TYPESAFE_JEV_PROVIDER)).toBe(true)
    expect(isVaultLlmProvider(TYPESAFE_JEV_PROVIDER)).toBe(false)
  })
})

describe('POST /v1/decide', () => {
  it('rejects unauthorized seats and never leaks secrets', async () => {
    const store = memoryStore()
    const res = await handleRequest(
      await signedRequest('/v1/decide', JSON.stringify({ template: 'intel_score', payload: { q: 'stand' } })),
      env(),
      {},
      { store, now: NOW }
    )
    expect(res.status).toBe(403)
    expect(JSON.stringify(await res.json())).not.toMatch(/Bearer|TYPESAFE|sk-/i)
  })

  it('mediates decide for approved seat; secret stays server-side; heartbeat flags jev', async () => {
    const store = memoryStore()
    const secret = 'ts-jev-TESTONLY-secret-ab12'
    const write = await handleRequest(
      new Request('https://operator.test/v1/admin/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'typesafe_jev', label: 'Jev', secret })
      }),
      env(),
      { access: tony },
      { store, now: NOW }
    )
    expect(write.status).toBe(200)
    const written = (await write.json()) as { ok: boolean; last4: string }
    expect(written.ok).toBe(true)
    expect(written.last4).toBe('ab12')

    await approveDevice(store)

    let sawAuth = ''
    const providerFetch: typeof fetch = async (_input, init) => {
      const h = init?.headers as Record<string, string>
      sawAuth = (h && (h.authorization || h.Authorization)) || ''
      return new Response(JSON.stringify({ result: { choice: 'a' }, confidence: 0.81 }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }

    const bodyText = JSON.stringify({
      template: 'action_disambiguate',
      payload: { candidates: ['notes', 'arc'] }
    })
    const res = await handleRequest(await signedRequest('/v1/decide', bodyText), env(), {}, { store, now: NOW, providerFetch })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      provider: string
      confidence: number | null
      secret?: string
    }
    expect(body.ok).toBe(true)
    expect(body.provider).toBe('typesafe_jev')
    expect(body.confidence).toBe(0.81)
    expect(body).not.toHaveProperty('secret')
    expect(JSON.stringify(body)).not.toContain(secret)
    expect(sawAuth).toBe(`Bearer ${secret}`)

    const beat = await handleRequest(await signedRequest('/v1/heartbeat', '{}', 'decide-hb-1'), env(), {}, { store, now: NOW })
    const hb = (await beat.json()) as {
      decisionProviders?: { jev?: boolean }
      fundedProviders?: string[]
    }
    expect(hb.decisionProviders?.jev).toBe(true)
    expect(hb.fundedProviders || []).not.toContain('typesafe_jev')
  })

  it('rejects unknown templates', async () => {
    const store = memoryStore()
    await approveDevice(store)
    await handleRequest(
      new Request('https://operator.test/v1/admin/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'typesafe_jev', secret: 'ts-jev-TESTONLY-secret-zz99' })
      }),
      env(),
      { access: tony },
      { store, now: NOW }
    )
    const res = await handleRequest(
      await signedRequest('/v1/decide', JSON.stringify({ template: 'chat_completion', payload: {} })),
      env(),
      {},
      { store, now: NOW }
    )
    expect(res.status).toBe(400)
  })
})

describe('decisionProvidersForSeat', () => {
  it('is false without key even when approved', async () => {
    const store = memoryStore()
    const flag = await decisionProvidersForSeat(
      store,
      { approval: 'approved', license: 'licensed', license_jti: null } as any,
      NOW,
      { jevEnabled: true, hasActiveJevKey: false }
    )
    expect(flag).toEqual({ jev: false })
  })
})
