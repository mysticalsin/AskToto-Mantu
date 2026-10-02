import { describe, expect, it } from 'vitest'
import { gatewayPrivacyHeaders, readinessForError, verifyDefaultGatewayPrivacy } from './ai-gateway'
import { reviewedGatewayReply } from './ai-gateway.privacy-fixture'

const TOKEN = 'FAKE_GATEWAY_REGRESSION_TOKEN_ONLY'
const ACCOUNT = 'test-account-0001'
const ROUTE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai-gateway/gateways/default`

function reply(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

/** A structural Response fake for the checks the real class won't let a test override
 * directly (`redirected`, `url`), and for exotic bodies (invalid UTF-8, oversize streams).
 */
function fakeResponse(overrides: {
  redirected?: boolean
  url?: string
  ok?: boolean
  status?: number
  headers?: Record<string, string>
  bodyBytes?: Uint8Array
}): Response {
  const headers = new Headers({ 'content-type': 'application/json', ...overrides.headers })
  const bytes =
    overrides.bodyBytes ??
    new TextEncoder().encode(
      JSON.stringify({ success: true, result: { id: 'default', collect_logs: false, cache_ttl: 0, logpush: false } })
    )
  return {
    redirected: overrides.redirected ?? false,
    url: overrides.url ?? '',
    ok: overrides.ok ?? true,
    status: overrides.status ?? 200,
    headers,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      }
    })
  } as unknown as Response
}

describe('R11 SRC-08: gateway privacy is read back, never auto-provisioned', () => {
  it('performs one body-free read of the expected sensitive route', async () => {
    const calls: { input: string; init?: RequestInit }[] = []
    const fetcher: typeof fetch = async (input, init) => {
      calls.push({ input: String(input), init })
      return reviewedGatewayReply()
    }
    await verifyDefaultGatewayPrivacy(TOKEN, ACCOUNT, fetcher)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.input).toBe(ROUTE)
    expect(calls[0]?.init?.method).toBe('GET')
    expect(calls[0]?.init?.body).toBeUndefined()
    expect(calls[0]?.init?.redirect).toBe('manual')
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
      await expect(verifyDefaultGatewayPrivacy(TOKEN, ACCOUNT, fetcher)).rejects.toMatchObject({ code: 'GATEWAY_CONFIGURATION_UNSAFE' })
    })
  }

  it('reports CONFIGURED after a passing readback and maps failures to UNREVIEWED or BLOCKED', async () => {
    await expect(verifyDefaultGatewayPrivacy(TOKEN, ACCOUNT, async () => reviewedGatewayReply())).resolves.toBe('CONFIGURED')
    const missing = await verifyDefaultGatewayPrivacy(TOKEN, ACCOUNT, async () => reply({ success: false }, 404)).catch((e) => e)
    expect(readinessForError(missing)).toBe('UNREVIEWED')
    const unsafe = await verifyDefaultGatewayPrivacy(TOKEN, ACCOUNT, async () =>
      reply({ success: true, result: { id: 'default', collect_logs: true, cache_ttl: 0, logpush: false } })).catch((e) => e)
    expect(readinessForError(unsafe)).toBe('BLOCKED')
  })

  it('sends metadata-only headers on the REST route, no log entry on a binding, and refuses an unproven transport', () => {
    expect(gatewayPrivacyHeaders('rest')).toEqual({
      'cf-aig-collect-log': 'true', 'cf-aig-collect-log-payload': 'false', 'cf-aig-skip-cache': 'true'
    })
    expect(gatewayPrivacyHeaders('binding')).toEqual({
      'cf-aig-collect-log': 'false', 'cf-aig-collect-log-payload': 'false', 'cf-aig-skip-cache': 'true'
    })
    expect(() => gatewayPrivacyHeaders('unproven')).toThrowError(expect.objectContaining({ code: 'GATEWAY_TRANSPORT_BLOCKED' }))
  })

  it('does not create a missing gateway', async () => {
    let calls = 0
    const fetcher: typeof fetch = async () => { calls++; return reply({ success: false }, 404) }
    await expect(verifyDefaultGatewayPrivacy(TOKEN, ACCOUNT, fetcher)).rejects.toMatchObject({ code: 'GATEWAY_REVIEW_REQUIRED' })
    expect(calls).toBe(1)
  })

  for (const status of [401, 403]) {
    it(`denies a ${status} without retrying`, async () => {
      let calls = 0
      const fetcher: typeof fetch = async () => { calls++; return reply({ success: false }, status) }
      await expect(verifyDefaultGatewayPrivacy(TOKEN, ACCOUNT, fetcher)).rejects.toMatchObject({ code: 'GATEWAY_CHECK_DENIED' })
      expect(calls).toBe(1)
    })
  }

  it('rejects any other non-2xx as unavailable', async () => {
    const fetcher: typeof fetch = async () => reply({ success: false }, 500)
    await expect(verifyDefaultGatewayPrivacy(TOKEN, ACCOUNT, fetcher)).rejects.toMatchObject({ code: 'GATEWAY_CHECK_UNAVAILABLE' })
  })

  it('rejects a redirected response', async () => {
    const fetcher: typeof fetch = async () => fakeResponse({ redirected: true })
    await expect(verifyDefaultGatewayPrivacy(TOKEN, ACCOUNT, fetcher)).rejects.toMatchObject({ code: 'GATEWAY_RESPONSE_UNVERIFIED' })
  })

  it('rejects a 302 with a Location header after exactly one fetch, never following it', async () => {
    let calls = 0
    const fetcher: typeof fetch = async () => {
      calls++
      return fakeResponse({ status: 302, ok: false, headers: { location: 'https://attacker.example/phish' } })
    }
    await expect(verifyDefaultGatewayPrivacy(TOKEN, ACCOUNT, fetcher)).rejects.toMatchObject({ code: 'GATEWAY_RESPONSE_UNVERIFIED' })
    expect(calls).toBe(1)
  })

  it('rejects a response whose final URL does not match the requested route', async () => {
    const fetcher: typeof fetch = async () => fakeResponse({ url: 'https://attacker.example/phish' })
    await expect(verifyDefaultGatewayPrivacy(TOKEN, ACCOUNT, fetcher)).rejects.toMatchObject({ code: 'GATEWAY_RESPONSE_UNVERIFIED' })
  })

  it('rejects a non-JSON content-type', async () => {
    const fetcher: typeof fetch = async () => fakeResponse({ headers: { 'content-type': 'text/plain' } })
    await expect(verifyDefaultGatewayPrivacy(TOKEN, ACCOUNT, fetcher)).rejects.toMatchObject({ code: 'GATEWAY_RESPONSE_UNVERIFIED' })
  })

  it('rejects a body over the byte cap by its declared content-length', async () => {
    const fetcher: typeof fetch = async () => fakeResponse({ headers: { 'content-length': '999999' } })
    await expect(verifyDefaultGatewayPrivacy(TOKEN, ACCOUNT, fetcher)).rejects.toMatchObject({ code: 'GATEWAY_RESPONSE_UNVERIFIED' })
  })

  it('rejects a body that streams past the byte cap with no content-length', async () => {
    const fetcher: typeof fetch = async () => fakeResponse({ bodyBytes: new Uint8Array(70_000) })
    await expect(verifyDefaultGatewayPrivacy(TOKEN, ACCOUNT, fetcher)).rejects.toMatchObject({ code: 'GATEWAY_RESPONSE_UNVERIFIED' })
  })

  it('rejects invalid UTF-8', async () => {
    const fetcher: typeof fetch = async () => fakeResponse({ bodyBytes: new Uint8Array([0xff, 0xfe, 0xfd]) })
    await expect(verifyDefaultGatewayPrivacy(TOKEN, ACCOUNT, fetcher)).rejects.toMatchObject({ code: 'GATEWAY_RESPONSE_UNVERIFIED' })
  })

  it('rejects invalid JSON', async () => {
    const fetcher: typeof fetch = async () => fakeResponse({ bodyBytes: new TextEncoder().encode('{not valid json') })
    await expect(verifyDefaultGatewayPrivacy(TOKEN, ACCOUNT, fetcher)).rejects.toMatchObject({ code: 'GATEWAY_RESPONSE_UNVERIFIED' })
  })

  it('rejects a gateway id other than default', async () => {
    const fetcher: typeof fetch = async () => reply({
      success: true, result: { id: 'not-default', collect_logs: false, cache_ttl: 0, logpush: false }
    })
    await expect(verifyDefaultGatewayPrivacy(TOKEN, ACCOUNT, fetcher)).rejects.toMatchObject({ code: 'GATEWAY_RESPONSE_UNVERIFIED' })
  })

  it.each([
    ['empty account id', '', TOKEN],
    ['an account id with path characters', '../etc', TOKEN],
    ['an empty token', ACCOUNT, ''],
    // A trailing newline is trimmed away before the check runs; an embedded one is not.
    ['a token carrying an embedded newline', ACCOUNT, `${TOKEN.slice(0, 4)}\n${TOKEN.slice(4)}`]
  ])('rejects %s before any network call', async (_label, accountId, token) => {
    let calls = 0
    const fetcher: typeof fetch = async () => { calls++; return reply({ success: false }) }
    await expect(verifyDefaultGatewayPrivacy(token, accountId, fetcher)).rejects.toMatchObject({ code: 'GATEWAY_CREDENTIALS_REQUIRED' })
    expect(calls).toBe(0)
  })

  it('bounds a body that never finishes and cancels its stream', async () => {
    let cancelled = false
    const fetcher: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({
      cancel() { cancelled = true }
    }), { headers: { 'content-type': 'application/json' } })
    await expect(verifyDefaultGatewayPrivacy(TOKEN, ACCOUNT, fetcher, { timeoutMs: 20 })).rejects.toMatchObject({ code: 'GATEWAY_CHECK_TIMEOUT' })
    expect(cancelled).toBe(true)
  })

  it('does not leak upstream error text', async () => {
    const fetcher: typeof fetch = async () => { throw new Error(`private error ${TOKEN}`) }
    await expect(verifyDefaultGatewayPrivacy(TOKEN, ACCOUNT, fetcher)).rejects.toMatchObject({ message: 'GATEWAY_CHECK_UNAVAILABLE' })
  })

  it.each([
    ['too low', 10],
    ['too high', 8_001],
    ['not a safe integer', 100.5]
  ])('rejects a %s test-only timeoutMs before any network call', async (_label, timeoutMs) => {
    let calls = 0
    const fetcher: typeof fetch = async () => { calls++; return reply({ success: false }) }
    await expect(verifyDefaultGatewayPrivacy(TOKEN, ACCOUNT, fetcher, { timeoutMs })).rejects.toMatchObject({
      code: 'GATEWAY_CHECK_OPTIONS_INVALID'
    })
    expect(calls).toBe(0)
  })
})
