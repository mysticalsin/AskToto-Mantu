import { beforeAll, describe, expect, it } from 'vitest'
import { GATEWAY_SOURCE, GATEWAY_TOKEN, gatewayPrivacyCheck, loadGatewayModule } from './gateway-privacy.mjs'

// The module the CI check runs: operator/src/ai-gateway.ts, bundled for Node by the check's own loader.
let gateway: Awaited<ReturnType<typeof loadGatewayModule>>
beforeAll(async () => {
  gateway = await loadGatewayModule()
}, 30_000)

const TOKEN = 'read-only-gateway-token'
const ACCOUNT = '0123456789abcdef0123456789abcdef'
const SAFE = { id: 'default', collect_logs: false, cache_ttl: 0, logpush: false }

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** A fake Cloudflare API: the accounts list, then the `default` gateway readback. */
function fakeApi({ accounts = [{ id: ACCOUNT, name: 'Staging account' }], config = SAFE as unknown, configStatus = 200 } = {}) {
  const requests: { url: string; authorization: string | null }[] = []
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    requests.push({ url, authorization: new Headers(init?.headers).get('authorization') })
    if (url.startsWith('https://api.cloudflare.com/client/v4/accounts?')) return json({ success: true, result: accounts })
    if (url === `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai-gateway/gateways/default`) {
      return json({ success: configStatus === 200, result: config }, configStatus)
    }
    return json({ success: false }, 404)
  }
  return { fetchImpl: fetchImpl as typeof fetch, requests }
}

const run = (api: ReturnType<typeof fakeApi>, token = TOKEN) =>
  gatewayPrivacyCheck({ secrets: { [GATEWAY_TOKEN]: token }, fetchImpl: api.fetchImpl, gateway })

describe('gateway-privacy', () => {
  it('reads the default gateway back through verifyDefaultGatewayPrivacy with the read-only token', async () => {
    expect(GATEWAY_SOURCE).toBe('operator/src/ai-gateway.ts')
    const api = fakeApi()
    const result = await run(api)
    expect(result).toEqual({
      ok: true,
      report: { gateway: 'default', readiness: 'CONFIGURED', error_code: null, settings: { collect_logs: false, cache_ttl: 0, logpush: false } }
    })
    expect(api.requests.map((request) => request.authorization)).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`])
    const text = JSON.stringify(result)
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain(ACCOUNT)
    expect(text).not.toContain('Staging account')
  })

  it('reports an unsafe gateway as BLOCKED with the settings it found, judged by the shared rules', async () => {
    const result = await run(fakeApi({ config: { ...SAFE, collect_logs: true, cache_ttl: 300, extra: 'ignored' } }))
    expect(result).toEqual({
      ok: false,
      report: {
        gateway: 'default',
        readiness: 'BLOCKED',
        error_code: 'GATEWAY_CONFIGURATION_UNSAFE',
        settings: { collect_logs: true, cache_ttl: 300, logpush: false }
      }
    })
    // otel is not one of the three reported settings, but the shared rules still refuse it.
    expect((await run(fakeApi({ config: { ...SAFE, otel: [{ url: 'https://collector.invalid' }] } }))).report.readiness).toBe('BLOCKED')
  })

  it('reports a missing gateway as UNREVIEWED and a denied token as BLOCKED, with no settings', async () => {
    const missing = await run(fakeApi({ configStatus: 404 }))
    expect(missing.report).toMatchObject({ readiness: 'UNREVIEWED', error_code: 'GATEWAY_REVIEW_REQUIRED' })
    expect(missing.report.settings).toEqual({ collect_logs: null, cache_ttl: null, logpush: null })
    expect((await run(fakeApi({ configStatus: 403 }))).report).toMatchObject({ readiness: 'BLOCKED', error_code: 'GATEWAY_CHECK_DENIED' })
  })

  it('fails closed without the token, or when the token does not see exactly one account', async () => {
    const noToken = fakeApi()
    expect((await run(noToken, '')).report).toMatchObject({ readiness: 'BLOCKED', error_code: 'GATEWAY_CREDENTIALS_REQUIRED' })
    expect(noToken.requests).toEqual([])
    for (const accounts of [[], [{ id: ACCOUNT, name: 'a' }, { id: 'f'.repeat(32), name: 'b' }]]) {
      const result = await run(fakeApi({ accounts }))
      expect(result).toMatchObject({ ok: false, report: { readiness: 'BLOCKED', error_code: 'GATEWAY_ACCOUNT_UNRESOLVED' } })
    }
  })
})
