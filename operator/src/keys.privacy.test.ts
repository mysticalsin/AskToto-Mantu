import { describe, expect, it } from 'vitest'
import { writeVaultKey, rotateVaultKey } from './keys'
import { memoryStore } from './store'
import { TEST_VAULT_KEY } from './test-fixtures'
import { reviewedGatewayFetch } from './ai-gateway.privacy-fixture'

const env = { OPERATOR_VAULT_KEY: TEST_VAULT_KEY }
const NOW = 1_725_000_000_000
const EMAIL = 'privacy-fixture@example.test'
const OLD = 'FAKE_PRIOR_TOKEN_TEST_ONLY_0001'
const NEXT = 'FAKE_REPLACEMENT_TOKEN_TEST_ONLY_0002'
const badFetch: typeof fetch = async () => new Response(JSON.stringify({
  success: true, result: { id: 'default', collect_logs: true, cache_ttl: 0, logpush: false }
}), { headers: { 'content-type': 'application/json' } })
const missingGatewayFetch: typeof fetch = async () => new Response('{"success":false}', { status: 404 })

async function seed() {
  const store = memoryStore()
  const added = await writeVaultKey(store, env, EMAIL, NOW, {
    provider: 'cloudflare', accountId: 'test-account-0001', secret: OLD
  }, reviewedGatewayFetch)
  if (!added.ok) throw new Error('Unable to seed the explicitly reviewed test fixture')
  return { store, id: added.id }
}

describe('R11 no credential mutation before privacy readback', () => {
  for (const operation of ['write', 'rotate'] as const) {
    it(`keeps the previous encrypted row, audit and event history on ${operation} failure`, async () => {
      const { store, id } = await seed()
      const before = await store.listVaultRows()
      const beforeAudit = await store.listAudit(100)
      const beforeEvents = await store.listEvents(100)
      const result = operation === 'write'
        ? await writeVaultKey(store, env, EMAIL, NOW + 1, {
            provider: 'cloudflare', accountId: 'test-account-0001', secret: NEXT
          }, badFetch)
        : await rotateVaultKey(store, env, EMAIL, NOW + 1, id, { secret: NEXT }, badFetch)
      expect(result).toMatchObject({ ok: false, status: 503, code: 'GATEWAY_CONFIGURATION_UNSAFE' })
      expect(await store.listVaultRows()).toEqual(before)
      expect(await store.listAudit(100)).toEqual(beforeAudit)
      expect(await store.listEvents(100)).toEqual(beforeEvents)
      expect(JSON.stringify(result)).not.toContain(OLD)
      expect(JSON.stringify(result)).not.toContain(NEXT)
    })
  }

  it('distinguishes a missing gateway from an unsafe one by code, not just a shared 503', async () => {
    const { store, id } = await seed()
    const missing = await rotateVaultKey(store, env, EMAIL, NOW + 1, id, { secret: NEXT }, missingGatewayFetch)
    const unsafe = await rotateVaultKey(store, env, EMAIL, NOW + 1, id, { secret: NEXT }, badFetch)
    expect(missing).toMatchObject({ ok: false, status: 503, code: 'GATEWAY_REVIEW_REQUIRED' })
    expect(unsafe).toMatchObject({ ok: false, status: 503, code: 'GATEWAY_CONFIGURATION_UNSAFE' })
  })

  it('requires accountId in the body when the stored row cannot be decrypted, before any gateway fetch', async () => {
    const { store, id } = await seed()
    const before = await store.listVaultRows()
    const beforeAudit = await store.listAudit(100)
    const beforeEvents = await store.listEvents(100)
    const wrongVaultEnv = { OPERATOR_VAULT_KEY: Buffer.alloc(32, 13).toString('base64') }
    let gatewayCalls = 0
    const countingFetch: typeof fetch = async () => {
      gatewayCalls++
      return new Response('{"success":false}', { status: 404 })
    }
    const result = await rotateVaultKey(store, wrongVaultEnv, EMAIL, NOW + 1, id, { secret: NEXT }, countingFetch)
    expect(result).toMatchObject({ ok: false, status: 400, error: 'accountId required' })
    expect(gatewayCalls).toBe(0)
    expect(await store.listVaultRows()).toEqual(before)
    expect(await store.listAudit(100)).toEqual(beforeAudit)
    expect(await store.listEvents(100)).toEqual(beforeEvents)
  })
})
