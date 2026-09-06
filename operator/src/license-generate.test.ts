import { describe, expect, it } from 'vitest'
import { handleRequest, type Env } from './index'
import { hmacHex } from './hmac'
import { sha256Hex } from './crypto'
import { ingestCanonical, OPERATOR_HMAC_HEADERS } from '../../src/shared/operator-hmac'
import { verifyOperatorLicense } from '../../src/shared/operator-license'
import { memoryStore } from './store'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY, TEST_VAULT_KEY } from './test-fixtures'

const NOW = 1_725_000_000_000
const SECRET = 'sk-ant-api03-OPERATOR-VAULT-TEST-only-xx99'

function env(): Env {
  return {
    OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET,
    OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY,
    OPERATOR_SKILL_PRIVATE_KEY: 'unused',
    OPERATOR_VAULT_KEY: TEST_VAULT_KEY
  }
}

const tony = { getIdentity: async () => ({ email: 'tony.walteur@gmail.com' }) }

async function signed(
  path: string,
  body: Record<string, unknown>,
  deviceId: string,
  nonce: string,
  now = NOW
) {
  const bodyText = JSON.stringify(body)
  const ts = String(now)
  const sig = await hmacHex(TEST_INGEST_SECRET, ingestCanonical(ts, nonce, deviceId, await sha256Hex(bodyText)))
  return handleRequest(
    new Request(`https://operator.test${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [OPERATOR_HMAC_HEADERS.ts]: ts,
        [OPERATOR_HMAC_HEADERS.nonce]: nonce,
        [OPERATOR_HMAC_HEADERS.device]: deviceId,
        [OPERATOR_HMAC_HEADERS.sig]: sig
      },
      body: bodyText
    }),
    env(),
    {},
    { store, now }
  )
}

let store = memoryStore()

describe('Operator generate license', () => {
  it('mints a token Tony can paste, stores last4 only, and 401s without Access', async () => {
    store = memoryStore()
    const unauth = await handleRequest(
      new Request('https://operator.test/v1/admin/licenses/generate', {
        method: 'POST',
        body: JSON.stringify({ days: 30 })
      }),
      env(),
      {},
      { store, now: NOW }
    )
    expect(unauth.status).toBe(401)
    expect(await unauth.json()).toEqual({ ok: false, error: 'Access required' })

    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/licenses/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ days: 30 })
      }),
      env(),
      { access: tony },
      { store, now: NOW }
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      license: string
      last4: string
      jti: string
      days: number
      exp: number
    }
    expect(body.ok).toBe(true)
    expect(body.days).toBe(30)
    expect(body.license.startsWith('METIS-OP-1.')).toBe(true)
    expect(body.license.length).toBeLessThanOrEqual(200)
    expect(JSON.stringify(await store.listIssuedLicenses())).not.toContain(body.license)
    expect((await store.getIssuedLicense(body.jti))?.last4).toBe(body.last4)
    const verified = await verifyOperatorLicense(TEST_INGEST_SECRET, body.license, NOW)
    expect(verified.ok).toBe(true)

    const badDays = await handleRequest(
      new Request('https://operator.test/v1/admin/licenses/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ days: 999 })
      }),
      env(),
      { access: tony },
      { store, now: NOW }
    )
    expect(badDays.status).toBe(400)
  })

  it('authorizes platform keys after an active license heartbeat, not after expiry', async () => {
    store = memoryStore()
    await handleRequest(
      new Request('https://operator.test/v1/admin/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'anthropic', secret: SECRET })
      }),
      env(),
      { access: tony },
      { store, now: NOW }
    )
    const minted = await handleRequest(
      new Request('https://operator.test/v1/admin/licenses/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ days: 7 })
      }),
      env(),
      { access: tony },
      { store, now: NOW }
    )
    const lic = (await minted.json()) as { jti: string; last4: string; exp: number }

    const pending = await signed(
      '/v1/heartbeat',
      { os: 'darwin', appVersion: '1.8.3', license: 'unlicensed' },
      'device-lic',
      'hb-pending'
    )
    const pendingJson = (await pending.json()) as { approved?: boolean; fundedProviders?: string[] }
    expect(pendingJson.approved).toBe(false)
    expect(pendingJson.fundedProviders).toEqual([])

    const active = await signed(
      '/v1/heartbeat',
      {
        os: 'darwin',
        appVersion: '1.8.3',
        license: 'licensed',
        licenseLast4: lic.last4,
        licenseId: lic.jti
      },
      'device-lic',
      'hb-lic'
    )
    const activeJson = (await active.json()) as { approved?: boolean; fundedProviders?: string[] }
    expect(activeJson.approved).toBe(true)
    expect(activeJson.fundedProviders).toEqual(['anthropic'])

    const useBody = JSON.stringify({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: 'hi' }]
    })
    const ts = String(NOW)
    const nonce = 'use-lic'
    const deviceId = 'device-lic'
    const useOk = await handleRequest(
      new Request('https://operator.test/v1/use', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [OPERATOR_HMAC_HEADERS.ts]: ts,
          [OPERATOR_HMAC_HEADERS.nonce]: nonce,
          [OPERATOR_HMAC_HEADERS.device]: deviceId,
          [OPERATOR_HMAC_HEADERS.sig]: await hmacHex(
            TEST_INGEST_SECRET,
            ingestCanonical(ts, nonce, deviceId, await sha256Hex(useBody))
          )
        },
        body: useBody
      }),
      env(),
      {},
      {
        store,
        now: NOW,
        providerFetch: async () =>
          new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
      }
    )
    expect(useOk.status).toBe(200)
    expect(((await useOk.json()) as { text?: string }).text).toBe('ok')

    const expiredBeat = await signed(
      '/v1/heartbeat',
      {
        os: 'darwin',
        appVersion: '1.8.3',
        license: 'licensed',
        licenseLast4: lic.last4,
        licenseId: lic.jti
      },
      'device-lic',
      'hb-exp',
      lic.exp * 1000
    )
    const expiredJson = (await expiredBeat.json()) as { approved?: boolean; fundedProviders?: string[] }
    expect(expiredJson.approved).toBe(false)
    expect(expiredJson.fundedProviders).toEqual([])
  })
})
