import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OPERATOR_ENROLL_HEADER, OPERATOR_HMAC_HEADERS, OPERATOR_LICENSE_HEADER } from '@shared/operator-hmac'
import {
  configureOperatorEnrollment,
  enrollmentAfterHeartbeat,
  enrollmentMemoryForTests,
  enrollmentOnSignedIn,
  enrollmentTick,
  operatorReportingStatusFor,
  type EnrollSettings,
  type EnrollmentDeps
} from './operator-enrollment'
import { configureOperatorReportingPolicy } from './operator-reporting-policy'

const BASE = 'https://operator.test'
const NOW = 1_800_000_000_000
const TOKEN = 'METIS-ENR-1.0123456789abcdef.secretsecretsecretsecretsecretsecretsecret1'
const LICENSE = 'METIS-OP-1.0123456789abcdef.1.2.AAAAAAAAAAAAAAAAAAAA'
const OK_BODY = {
  ok: true,
  license: LICENSE,
  jti: '0123456789abcdef',
  last4: 'AAAA',
  exp: NOW / 1000 + 86_400,
  origin: 'token-enroll',
  tier: 'reporting'
}

interface Call {
  url: string
  init: RequestInit
}

function harness(over: Partial<EnrollmentDeps> = {}, settings: Partial<EnrollSettings> = {}) {
  const calls: Call[] = []
  let response: () => Response = () =>
    new Response(JSON.stringify(OK_BODY), { status: 200, headers: { 'content-type': 'application/json' } })
  const state = { settings: { operatorUrl: BASE, ...settings } as EnrollSettings, now: NOW }
  const deps: EnrollmentDeps = {
    getSettings: () => state.settings,
    now: () => state.now,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} })
      return response()
    }) as typeof fetch,
    deviceId: () => 'devicehash0123456789abcdef01234567',
    idToken: async () => ({ idToken: 'header.payload.signature' }),
    signedIn: () => false,
    embeddedToken: () => ({ token: TOKEN, operatorUrl: BASE }),
    currentLicense: () => null,
    applyAutoLicense: vi.fn(async () => ({ ok: true })),
    promote: vi.fn(),
    demote: vi.fn(),
    drop: vi.fn(),
    revoke: vi.fn(),
    noteRevokedChecked: vi.fn(),
    appVersion: () => '2.12.0-test',
    os: () => 'test',
    rand: () => 0.5,
    ...over
  }
  configureOperatorEnrollment(deps)
  return {
    deps,
    calls,
    state,
    respond: (next: () => Response) => {
      response = next
    }
  }
}

const jsonResponse = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

beforeEach(() => configureOperatorReportingPolicy(null))
afterEach(() => {
  configureOperatorEnrollment(null)
  configureOperatorReportingPolicy(null)
})

describe('token path', () => {
  it('POSTs only to /v1/enroll with the enrolment token as header and signing key, then applies the licence', async () => {
    const h = harness()
    await enrollmentTick('test')
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].url).toBe(`${BASE}/v1/enroll`)
    const headers = h.calls[0].init.headers as Record<string, string>
    expect(headers[OPERATOR_ENROLL_HEADER]).toBe(TOKEN)
    expect(headers[OPERATOR_HMAC_HEADERS.sig]).toMatch(/^[a-f0-9]{64}$/)
    expect(headers[OPERATOR_HMAC_HEADERS.device]).toBe('devicehash0123456789abcdef01234567')
    expect(JSON.parse(String(h.calls[0].init.body))).toEqual({ method: 'token', appVersion: '2.12.0-test', os: 'test' })
    expect(h.deps.applyAutoLicense).toHaveBeenCalledWith(LICENSE, 'token')
  })

  it('does not use an embedded token bound to a different Operator URL', async () => {
    const h = harness({ embeddedToken: () => ({ token: TOKEN, operatorUrl: 'https://other.example' }) })
    await enrollmentTick('test')
    expect(h.calls).toHaveLength(0)
  })

  it('falls back to SSO only when there is no embedded token, and queues otherwise', async () => {
    const h = harness({ embeddedToken: () => null })
    await enrollmentTick('test')
    expect(h.calls).toHaveLength(0)
  })

  it('stops using a revoked token until the app updates', async () => {
    const h = harness()
    h.respond(() => jsonResponse({ ok: false, code: 'token-revoked' }, 401))
    await enrollmentTick('test')
    expect(enrollmentMemoryForTests().tokenOff).toBe(true)
    await enrollmentTick('test')
    expect(h.calls).toHaveLength(1)
  })
})

describe('sso path', () => {
  it('prefers SSO when signed in, sends the ID token in the body and as the signing key', async () => {
    const h = harness({ signedIn: () => true })
    await enrollmentTick('test')
    expect(h.calls).toHaveLength(1)
    expect(JSON.parse(String(h.calls[0].init.body))).toMatchObject({
      method: 'sso',
      idToken: 'header.payload.signature'
    })
    const headers = h.calls[0].init.headers as Record<string, string>
    expect(headers[OPERATOR_ENROLL_HEADER]).toBeUndefined()
    expect(h.deps.applyAutoLicense).toHaveBeenCalledWith(LICENSE, 'sso')
  })

  it('an sso refusal blocks SSO until the next sign-in, which re-opens it', async () => {
    const h = harness({ signedIn: () => true, embeddedToken: () => null })
    h.respond(() => jsonResponse({ ok: false, code: 'sso-tenant' }, 403))
    await enrollmentTick('test')
    expect(enrollmentMemoryForTests().ssoBlockedUntilSignIn).toBe(true)
    await enrollmentTick('test')
    expect(h.calls).toHaveLength(1)
    h.respond(() => jsonResponse(OK_BODY, 200))
    enrollmentOnSignedIn()
    await vi.waitFor(() => expect(h.calls).toHaveLength(2))
  })

  it('without a fresh ID token it blocks SSO and makes no request', async () => {
    const h = harness({ signedIn: () => true, embeddedToken: () => null, idToken: async () => null })
    await enrollmentTick('test')
    expect(h.calls).toHaveLength(0)
    expect(enrollmentMemoryForTests().ssoBlockedUntilSignIn).toBe(true)
  })

  it('upgrades a token seat by presenting the licence it already holds', async () => {
    const h = harness(
      { signedIn: () => true, currentLicense: () => ({ token: LICENSE, expiresAt: NOW + 20 * 86_400_000 }) },
      {
        operatorEnrollState: 'enrolled',
        operatorLicenseOrigin: 'token',
        operatorReportingExpiresAt: NOW + 20 * 86_400_000
      }
    )
    await enrollmentTick('test')
    expect((h.calls[0].init.headers as Record<string, string>)[OPERATOR_LICENSE_HEADER]).toBe(LICENSE)
    expect(JSON.parse(String(h.calls[0].init.body)).method).toBe('sso')
  })
})

describe('backoff and failure handling', () => {
  it('backs off after a 5xx and does not retry before the window ends', async () => {
    const h = harness()
    h.respond(() => jsonResponse({ ok: false }, 503))
    await enrollmentTick('test')
    expect(enrollmentMemoryForTests().nextAttemptAt).toBe(NOW + 30_000)
    await enrollmentTick('test')
    expect(h.calls).toHaveLength(1)
    h.state.now = NOW + 30_000
    await enrollmentTick('test')
    expect(h.calls).toHaveLength(2)
  })

  it('treats an Access login redirect as unreachable for 6 hours, never as revoked', async () => {
    const h = harness()
    h.respond(
      () => new Response('<html>login</html>', { status: 302, headers: { location: 'https://x.cloudflareaccess.com' } })
    )
    await enrollmentTick('test')
    expect(h.deps.revoke).not.toHaveBeenCalled()
    expect(enrollmentMemoryForTests().nextAttemptAt).toBe(NOW + 6 * 60 * 60 * 1000)
  })

  it('treats a network error as a retry', async () => {
    const h = harness({
      fetch: (async () => {
        throw new Error('ECONNREFUSED')
      }) as typeof fetch
    })
    await enrollmentTick('test')
    expect(h.deps.applyAutoLicense).not.toHaveBeenCalled()
    expect(enrollmentMemoryForTests()).toMatchObject({ attempt: 1, inFlight: false })
  })

  it('goes to revoked on seat-revoked', async () => {
    const h = harness()
    h.respond(() => jsonResponse({ ok: false, code: 'seat-revoked' }, 403))
    await enrollmentTick('test')
    expect(h.deps.revoke).toHaveBeenCalledTimes(1)
  })

  it('retries when the licence could not be confirmed by the first heartbeat', async () => {
    const h = harness({ applyAutoLicense: vi.fn(async () => ({ ok: false, error: 'x' })) })
    await enrollmentTick('test')
    expect(enrollmentMemoryForTests().attempt).toBe(1)
    expect(h.calls).toHaveLength(1)
  })

  it('runs one attempt at a time', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const h = harness({
      fetch: (async () => {
        await gate
        return jsonResponse(OK_BODY, 200)
      }) as typeof fetch
    })
    const first = enrollmentTick('a')
    await vi.waitFor(() => expect(enrollmentMemoryForTests().inFlight).toBe(true))
    await enrollmentTick('b')
    release()
    await first
    expect(h.deps.applyAutoLicense).toHaveBeenCalledTimes(1)
  })

  it('drops a licence the Worker refuses to renew so the next attempt enrols afresh', async () => {
    const h = harness(
      { currentLicense: () => ({ token: LICENSE, expiresAt: NOW + 3 * 86_400_000 }) },
      {
        operatorEnrollState: 'enrolled',
        operatorLicenseOrigin: 'token',
        operatorReportingExpiresAt: NOW + 3 * 86_400_000
      }
    )
    h.respond(() => jsonResponse({ ok: false, code: 'license-expired' }, 401))
    await enrollmentTick('test')
    expect(JSON.parse(String(h.calls[0].init.body)).method).toBe('renew')
    expect(h.deps.drop).toHaveBeenCalledTimes(1)
  })
})

describe('boundaries', () => {
  it('makes no request while the admin kill switch is on', async () => {
    configureOperatorReportingPolicy({ readAdmin: () => '{"operatorReporting":false}' })
    const h = harness()
    await enrollmentTick('test')
    expect(h.calls).toHaveLength(0)
  })

  it('never touches an admin licence or legacy secret', async () => {
    const h1 = harness({}, { operatorLicenseToken: LICENSE, operatorLicenseOrigin: 'admin' })
    await enrollmentTick('test')
    expect(h1.calls).toHaveLength(0)
    const h2 = harness({}, { operatorIngestSecret: 'legacy-shared-secret' })
    await enrollmentTick('test')
    expect(h2.calls).toHaveLength(0)
  })

  it('makes no request without a persisted device identity', async () => {
    const h = harness({ deviceId: () => null })
    await enrollmentTick('test')
    expect(h.calls).toHaveLength(0)
  })

  it('re-checks a revoked device at most once a day', async () => {
    const h = harness({}, { operatorEnrollState: 'revoked', operatorEnrollCheckedAt: NOW - 1000 })
    await enrollmentTick('test')
    expect(h.calls).toHaveLength(0)
    h.state.settings = { ...h.state.settings, operatorEnrollCheckedAt: NOW - 24 * 60 * 60 * 1000 }
    await enrollmentTick('test')
    expect(h.calls).toHaveLength(1)
  })
})

describe('after a heartbeat', () => {
  const auto = { operatorLicenseOrigin: 'sso' as const, operatorEnrollState: 'enrolled' as const }
  it('promotes an auto seat the administrator upgraded, and demotes it again', async () => {
    const h = harness({}, auto)
    await enrollmentAfterHeartbeat({ ok: true, retry: [], tier: 'metis' })
    expect(h.deps.promote).toHaveBeenCalledTimes(1)
    await enrollmentAfterHeartbeat({ ok: true, retry: [], tier: 'reporting' })
    expect(h.deps.demote).toHaveBeenCalledTimes(1)
  })
  it('revokes on seat-revoked and drops an expired licence', async () => {
    const h = harness({}, auto)
    await enrollmentAfterHeartbeat({ ok: false, retry: [], denied: { status: 403, code: 'seat-revoked' } })
    expect(h.deps.revoke).toHaveBeenCalledTimes(1)
    await enrollmentAfterHeartbeat({ ok: false, retry: [], denied: { status: 401, code: 'license-expired' } })
    expect(h.deps.drop).toHaveBeenCalledTimes(1)
  })
  it('ignores an unexplained 401 or 403 (a proxy, Access, a clock problem)', async () => {
    const h = harness({}, auto)
    await enrollmentAfterHeartbeat({ ok: false, retry: [], denied: { status: 403 } })
    expect(h.deps.revoke).not.toHaveBeenCalled()
    expect(h.deps.drop).not.toHaveBeenCalled()
  })
  it('never acts on an admin seat', async () => {
    const h = harness({}, { operatorLicenseToken: LICENSE, operatorLicenseOrigin: 'admin' })
    await enrollmentAfterHeartbeat({ ok: true, retry: [], tier: 'reporting' })
    await enrollmentAfterHeartbeat({ ok: false, retry: [], denied: { status: 403, code: 'seat-revoked' } })
    expect(h.deps.demote).not.toHaveBeenCalled()
    expect(h.deps.revoke).not.toHaveBeenCalled()
  })
})

describe('operatorReportingStatusFor', () => {
  it('maps the four UI states', () => {
    expect(operatorReportingStatusFor({ operatorUrl: BASE })).toBe('pending')
    expect(operatorReportingStatusFor({ operatorUrl: BASE, operatorReportingToken: LICENSE })).toBe('enrolled')
    expect(operatorReportingStatusFor({ operatorUrl: BASE, operatorLicenseToken: LICENSE })).toBe('enrolled')
    expect(operatorReportingStatusFor({ operatorUrl: BASE, operatorEnrollState: 'revoked' })).toBe('revoked')
    configureOperatorReportingPolicy({ readAdmin: () => '{"operatorReporting":false}' })
    expect(operatorReportingStatusFor({ operatorUrl: BASE, operatorReportingToken: LICENSE })).toBe('off-by-policy')
  })
})
