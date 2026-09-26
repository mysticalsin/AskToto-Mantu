import { describe, expect, it } from 'vitest'
import { ensureDefaultAiGateway } from './ai-gateway'
import { reviewedGatewayReply } from './ai-gateway.privacy-fixture'

const TOKEN = 'FAKE_GATEWAY_REGRESSION_TOKEN_ONLY'
const ACCOUNT = 'test-account-0001'
function reply(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

describe('R11 SRC-08: gateway privacy is read back, never auto-provisioned', () => {
  it('performs one body-free read of the expected sensitive route', async () => {
    const calls: { input: string; init?: RequestInit }[] = []
    const fetcher: typeof fetch = async (input, init) => {
      calls.push({ input: String(input), init })
      return reviewedGatewayReply()
    }
    await ensureDefaultAiGateway(TOKEN, ACCOUNT, fetcher)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.input).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai-gateway/gateways/default`)
    expect(calls[0]?.init?.method).toBe('GET')
    expect(calls[0]?.init?.body).toBeUndefined()
    expect(calls[0]?.init?.redirect).toBe('error')
  })

  for (const bad of [
    { collect_logs: true }, { collect_logs: undefined }, { collect_logs: 'false' },
    { cache_ttl: 30 }, { cache_ttl: '0' }, { logpush: true }, { logpush: undefined },
    { otel: [{ url: 'https://unapproved.example/collector' }] }, { log_classification: true }
  ]) {
    it(`blocks unsafe or unknown settings ${JSON.stringify(bad)}`, async () => {
      const fetcher: typeof fetch = async () => reply({ success: true, result: {
        id: 'default', collect_logs: false, cache_ttl: 0, logpush: false, ...bad
      } })
      await expect(ensureDefaultAiGateway(TOKEN, ACCOUNT, fetcher)).rejects.toMatchObject({ code: 'GATEWAY_CONFIGURATION_UNSAFE' })
    })
  }

  it('does not create a missing gateway', async () => {
    let calls = 0
    const fetcher: typeof fetch = async () => { calls++; return reply({ success: false }, 404) }
    await expect(ensureDefaultAiGateway(TOKEN, ACCOUNT, fetcher)).rejects.toMatchObject({ code: 'GATEWAY_REVIEW_REQUIRED' })
    expect(calls).toBe(1)
  })

  it('bounds a body that never finishes and cancels its stream', async () => {
    let cancelled = false
    const fetcher: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({
      cancel() { cancelled = true }
    }), { headers: { 'content-type': 'application/json' } })
    await expect(ensureDefaultAiGateway(TOKEN, ACCOUNT, fetcher, { timeoutMs: 20 })).rejects.toMatchObject({ code: 'GATEWAY_CHECK_TIMEOUT' })
    expect(cancelled).toBe(true)
  })

  it('does not leak upstream error text', async () => {
    const fetcher: typeof fetch = async () => { throw new Error(`private error ${TOKEN}`) }
    await expect(ensureDefaultAiGateway(TOKEN, ACCOUNT, fetcher)).rejects.toMatchObject({ message: 'GATEWAY_CHECK_UNAVAILABLE' })
  })
})
