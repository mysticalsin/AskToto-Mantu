import { describe, expect, it } from 'vitest'
import { handleRequest, type Env } from './index'
import { memoryStore } from './store'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY, TEST_VAULT_KEY } from './test-fixtures'
import { tokenPatternForTests } from './redact'
import { FORBIDDEN_VAULT_PROVIDERS } from './vault'

const NOW = 1_725_000_000_000

function env(): Env {
  return {
    OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET,
    OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY,
    OPERATOR_SKILL_PRIVATE_KEY: 'unused',
    OPERATOR_VAULT_KEY: TEST_VAULT_KEY
  }
}

const tony = { getIdentity: async () => ({ email: 'tony.walteur@gmail.com' }) }

describe('admin keys write / rotate / revoke', () => {
  it('adds a key, returns last4 only, and never echoes the secret', async () => {
    const store = memoryStore()
    const secret = 'sk-ant-api03-TESTKEYONLY-not-a-real-secret-xx99'
    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'anthropic', label: 'Tony cloud', secret })
      }),
      env(),
      { access: tony },
      { store, now: NOW }
    )
    expect(res.status).toBe(200)
    const written = (await res.json()) as { ok: boolean; id: string; last4: string; secret?: string }
    expect(written.ok).toBe(true)
    expect(written.last4).toBe('xx99')
    expect(written).not.toHaveProperty('secret')
    expect(JSON.stringify(written)).not.toContain(secret)
    expect(JSON.stringify(written)).not.toMatch(/cipher|\"iv\"/)

    const list = await handleRequest(
      new Request('https://operator.test/v1/admin/keys'),
      env(),
      { access: tony },
      { store, now: NOW }
    )
    const body = (await list.json()) as {
      vault: { provider: string; last4: string; status: string }[]
      vaultBound: boolean
    }
    expect(body.vaultBound).toBe(true)
    expect(body.vault).toEqual([
      expect.objectContaining({ provider: 'anthropic', last4: 'xx99', status: 'active' })
    ])
    expect(JSON.stringify(body)).not.toContain(secret)
    expect(JSON.stringify(body)).not.toMatch(/\"cipher\"|\"iv\"/)

    const home = await handleRequest(
      new Request('https://operator.test/'),
      env(),
      { access: tony },
      { store, now: NOW }
    )
    expect(home.status).toBe(200)
    expect(home.headers.get('content-type')).toMatch(/text\/html/)
    const html = await home.text()
    expect(html).toContain('··xx99')
    expect(html).not.toContain(secret)
    expect(html).not.toContain('Seats keep their own keys')
    expect(html).toContain('Add an API')
    expect(html).toContain('id="key-add"')
    expect(html).toContain('name="accountId"')
    expect(html).toContain('data-page="keys"')
    expect(html).toContain('data-page="map"')
  })

  it('rejects CLI and Dust as vault providers', async () => {
    const store = memoryStore()
    for (const provider of FORBIDDEN_VAULT_PROVIDERS) {
      const res = await handleRequest(
        new Request('https://operator.test/v1/admin/keys', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider, secret: 'not-a-cli-token' })
        }),
        env(),
        { access: tony },
        { store, now: NOW }
      )
      expect(res.status, provider).toBe(400)
    }
    expect((await store.listVaultMeta()).length).toBe(0)
  })

  it('rotates and revokes with last4 only, and funds heartbeat from active LLM rows', async () => {
    const store = memoryStore()
    const created = await handleRequest(
      new Request('https://operator.test/v1/admin/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'openai', secret: 'sk-proj-oldkey-abcd' })
      }),
      env(),
      { access: tony },
      { store, now: NOW }
    )
    const id = ((await created.json()) as { id: string }).id
    const rotated = await handleRequest(
      new Request(`https://operator.test/v1/admin/keys/${id}/rotate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret: 'sk-proj-newkey-wxyz' })
      }),
      env(),
      { access: tony },
      { store, now: NOW + 1 }
    )
    const rot = (await rotated.json()) as { last4: string; secret?: string }
    expect(rot.last4).toBe('wxyz')
    expect(rot).not.toHaveProperty('secret')

    const { hmacHex } = await import('./hmac')
    const { sha256Hex } = await import('./crypto')
    const { ingestCanonical, OPERATOR_HMAC_HEADERS } = await import('../../src/shared/operator-hmac')
    const bodyText = JSON.stringify({ os: 'darwin', appVersion: '1.8.2' })
    const ts = String(NOW + 2)
    const nonce = 'keys-hb'
    const deviceId = 'device-keys'
    const sig = await hmacHex(TEST_INGEST_SECRET, ingestCanonical(ts, nonce, deviceId, await sha256Hex(bodyText)))
    const beat = await handleRequest(
      new Request('https://operator.test/v1/heartbeat', {
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
      { store, now: NOW + 2 }
    )
    const hb = (await beat.json()) as { fundedProviders?: string[] }
    expect(hb.fundedProviders).toEqual(['openai'])

    const revoked = await handleRequest(
      new Request(`https://operator.test/v1/admin/keys/${id}/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      }),
      env(),
      { access: tony },
      { store, now: NOW + 3 }
    )
    expect(((await revoked.json()) as { status: string }).status).toBe('revoked')
    const events = await store.listEvents(10)
    const blob = JSON.stringify(events)
    expect(blob).not.toMatch(tokenPatternForTests())
    expect(blob).not.toContain('sk-proj-newkey')
    expect(blob).not.toContain('sk-proj-oldkey')
  })

  it('requires Tony identity and never serves keys to a stranger', async () => {
    const denied = await handleRequest(
      new Request('https://operator.test/v1/admin/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'anthropic', secret: 'sk-ant-nope' })
      }),
      env(),
      {},
      { store: memoryStore(), now: NOW }
    )
    expect(denied.status).toBe(401)
    const other = await handleRequest(
      new Request('https://operator.test/v1/admin/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'anthropic', secret: 'sk-ant-nope' })
      }),
      env(),
      { access: { getIdentity: async () => ({ email: 'other@example.com' }) } },
      { store: memoryStore(), now: NOW }
    )
    expect(other.status).toBe(401)
  })
})
