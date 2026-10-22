import { describe, expect, it } from 'vitest'
import {
  ENROLL_BACKOFF_SCHEDULE_MS,
  ENROLL_RENEW_AHEAD_MS,
  ENROLL_UNREACHABLE_RETRY_MS,
  REVOKED_RECHECK_MS,
  applyEnrollOutcome,
  classifyEnrollResponse,
  decideEnrollment,
  emptyEnrollMemory,
  enrollBackoffMs,
  type EnrollDecisionInput
} from './operator-enrollment-machine'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000
const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', location: null, json: body })

function input(over: Partial<EnrollDecisionInput> = {}): EnrollDecisionInput {
  return {
    now: NOW,
    policyAllowed: true,
    urlOk: true,
    adminCredential: false,
    state: 'unenrolled',
    origin: null,
    reportingExpiresAt: null,
    revokedCheckedAt: 0,
    ssoAvailable: false,
    tokenAvailable: false,
    memory: emptyEnrollMemory(),
    ...over
  }
}

describe('enrollBackoffMs', () => {
  it('follows 30 s, 2 m, 10 m, 1 h then caps at 6 h (no jitter)', () => {
    expect(ENROLL_BACKOFF_SCHEDULE_MS).toEqual([30_000, 120_000, 600_000, 3_600_000, 21_600_000])
    const mid = () => 0.5
    expect([0, 1, 2, 3, 4, 5, 20].map((n) => enrollBackoffMs(n, mid))).toEqual([
      30_000, 120_000, 600_000, 3_600_000, 21_600_000, 21_600_000, 21_600_000
    ])
  })
  it('jitters by plus or minus 20 percent', () => {
    expect(enrollBackoffMs(0, () => 0)).toBe(24_000)
    expect(enrollBackoffMs(0, () => 1)).toBe(36_000)
  })
})

describe('decideEnrollment', () => {
  it('does nothing while the admin kill switch is on', () => {
    expect(decideEnrollment(input({ policyAllowed: false, ssoAvailable: true, tokenAvailable: true }))).toEqual({
      action: 'none',
      phase: 'disabled'
    })
  })
  it('does nothing without a usable https address', () => {
    expect(decideEnrollment(input({ urlOk: false, tokenAvailable: true })).action).toBe('none')
  })
  it('never touches a manual, MDM or legacy-secret credential', () => {
    expect(decideEnrollment(input({ adminCredential: true, ssoAvailable: true, tokenAvailable: true })).action).toBe(
      'none'
    )
    expect(decideEnrollment(input({ origin: 'admin', state: 'enrolled', ssoAvailable: true })).action).toBe('none')
  })
  it('stays unenrolled and keeps queueing when there is neither a sign-in nor an embedded token', () => {
    expect(decideEnrollment(input())).toEqual({ action: 'none', phase: 'unenrolled' })
  })
  it('prefers the SSO path when signed in', () => {
    expect(decideEnrollment(input({ ssoAvailable: true, tokenAvailable: true }))).toMatchObject({
      action: 'attempt',
      method: 'sso'
    })
  })
  it('falls back to the embedded token when signed out', () => {
    expect(decideEnrollment(input({ tokenAvailable: true }))).toMatchObject({ action: 'attempt', method: 'token' })
  })
  it('falls back to the token when SSO is blocked until the next sign-in', () => {
    const memory = { ...emptyEnrollMemory(), ssoBlockedUntilSignIn: true }
    expect(decideEnrollment(input({ ssoAvailable: true, tokenAvailable: true, memory }))).toMatchObject({
      method: 'token'
    })
    expect(decideEnrollment(input({ ssoAvailable: true, memory })).action).toBe('none')
  })
  it('does not attempt before the backoff window ends or while another attempt runs', () => {
    const waiting = { ...emptyEnrollMemory(), nextAttemptAt: NOW + 1 }
    expect(decideEnrollment(input({ tokenAvailable: true, memory: waiting })).action).toBe('none')
    expect(
      decideEnrollment(input({ tokenAvailable: true, memory: { ...emptyEnrollMemory(), inFlight: true } })).action
    ).toBe('none')
    expect(
      decideEnrollment(input({ tokenAvailable: true, memory: { ...emptyEnrollMemory(), nextAttemptAt: NOW } })).action
    ).toBe('attempt')
  })
  it('does not use a token that was revoked or expired on the Worker', () => {
    const memory = { ...emptyEnrollMemory(), tokenOff: true }
    expect(decideEnrollment(input({ tokenAvailable: true, memory })).action).toBe('none')
  })
  it('renews inside the 14 day window and not before', () => {
    const fresh = input({ state: 'enrolled', origin: 'token', reportingExpiresAt: NOW + 20 * DAY })
    expect(decideEnrollment(fresh).action).toBe('none')
    const due = input({ state: 'enrolled', origin: 'token', reportingExpiresAt: NOW + ENROLL_RENEW_AHEAD_MS - 1 })
    expect(decideEnrollment(due)).toMatchObject({ action: 'attempt', method: 'renew' })
  })
  it('enrols afresh, not renews, once the licence has expired', () => {
    const expired = input({ state: 'enrolled', origin: 'sso', reportingExpiresAt: NOW - 1, tokenAvailable: true })
    expect(decideEnrollment(expired)).toMatchObject({ action: 'attempt', method: 'token' })
  })
  it('upgrades a token-enrolled device to SSO as soon as a fresh ID token is available', () => {
    const upgrade = input({
      state: 'enrolled',
      origin: 'token',
      reportingExpiresAt: NOW + 25 * DAY,
      ssoAvailable: true
    })
    expect(decideEnrollment(upgrade)).toMatchObject({ action: 'attempt', method: 'sso' })
    const already = input({ state: 'enrolled', origin: 'sso', reportingExpiresAt: NOW + 80 * DAY, ssoAvailable: true })
    expect(decideEnrollment(already).action).toBe('none')
  })
  it('re-checks a revoked device only once a day', () => {
    const recent = input({ state: 'revoked', revokedCheckedAt: NOW - 1000, tokenAvailable: true })
    expect(decideEnrollment(recent)).toEqual({ action: 'none', phase: 'revoked' })
    const due = input({ state: 'revoked', revokedCheckedAt: NOW - REVOKED_RECHECK_MS, tokenAvailable: true })
    expect(decideEnrollment(due)).toMatchObject({ action: 'attempt', method: 'token' })
  })
})

describe('classifyEnrollResponse', () => {
  const ok = {
    ok: true,
    license: 'METIS-OP-1.aaaaaaaaaaaaaaaa.1.2.sig',
    jti: 'aaaaaaaaaaaaaaaa',
    last4: 'abcd',
    exp: 2,
    origin: 'token-enroll',
    tier: 'reporting'
  }
  it('accepts a licence response', () => {
    expect(classifyEnrollResponse(json(ok))).toMatchObject({ kind: 'ok', license: ok.license, jti: ok.jti })
  })
  it('refuses a licence-shaped response from a non-OK or malformed body', () => {
    expect(classifyEnrollResponse(json({ ok: true }))).toMatchObject({ kind: 'retry' })
    expect(classifyEnrollResponse(json({ ...ok, license: 'nope' }))).toMatchObject({ kind: 'retry' })
  })
  it('treats a network failure, 5xx and 429 as retry, honouring retryAfterMs', () => {
    expect(classifyEnrollResponse(null)).toMatchObject({ kind: 'retry' })
    expect(classifyEnrollResponse(json({ ok: false }, 503))).toMatchObject({ kind: 'retry' })
    expect(classifyEnrollResponse(json({ ok: false, code: 'rate', retryAfterMs: 90_000 }, 429))).toEqual({
      kind: 'retry',
      retryAfterMs: 90_000
    })
  })
  it('treats 404, 3xx and Access HTML as unreachable for 6 hours, never as revoked', () => {
    expect(classifyEnrollResponse({ status: 404, contentType: 'text/plain', location: null, json: null })).toEqual({
      kind: 'unreachable',
      retryAfterMs: ENROLL_UNREACHABLE_RETRY_MS
    })
    expect(
      classifyEnrollResponse({
        status: 302,
        contentType: 'text/html',
        location: 'https://x.cloudflareaccess.com/',
        json: null
      })
    ).toMatchObject({ kind: 'unreachable' })
    expect(classifyEnrollResponse({ status: 200, contentType: 'text/html', location: null, json: null })).toMatchObject(
      {
        kind: 'unreachable'
      }
    )
    expect(classifyEnrollResponse(json({ ok: false, code: 'enroll-paused' }, 503))).toMatchObject({
      kind: 'unreachable'
    })
  })
  it('maps sso failures to an SSO stop and token failures to a token stop', () => {
    for (const code of ['sso-invalid', 'sso-tenant', 'sso-domain', 'sso-stale', 'sso-replay', 'enroll-unconfigured']) {
      expect(classifyEnrollResponse(json({ ok: false, code }, 401))).toEqual({ kind: 'sso-stop' })
    }
    for (const code of ['token-invalid', 'token-revoked', 'token-expired']) {
      expect(classifyEnrollResponse(json({ ok: false, code }, 401))).toEqual({ kind: 'token-off' })
    }
  })
  it('maps seat-revoked to revoked and admin-licensed to a long wait', () => {
    expect(classifyEnrollResponse(json({ ok: false, code: 'seat-revoked' }, 403))).toEqual({ kind: 'revoked' })
    expect(classifyEnrollResponse(json({ ok: false, code: 'admin-licensed' }, 409))).toEqual({
      kind: 'unreachable',
      retryAfterMs: ENROLL_UNREACHABLE_RETRY_MS
    })
  })
  it('maps caps and rate limits to a retry', () => {
    expect(classifyEnrollResponse(json({ ok: false, code: 'token-cap' }, 429)).kind).toBe('retry')
    expect(classifyEnrollResponse(json({ ok: false, code: 'rate' }, 429)).kind).toBe('retry')
  })
})

describe('applyEnrollOutcome', () => {
  const rand = () => 0.5
  it('resets the failure count on success', () => {
    const m = { ...emptyEnrollMemory(), attempt: 3, inFlight: true }
    const next = applyEnrollOutcome(m, 'sso', { kind: 'ok', license: 'x', jti: 'j', last4: 'l', exp: 1 }, NOW, rand)
    expect(next).toMatchObject({ attempt: 0, inFlight: false, nextAttemptAt: 0 })
  })
  it('backs off with the schedule on retry and honours retryAfterMs', () => {
    let m = { ...emptyEnrollMemory(), inFlight: true }
    m = applyEnrollOutcome(m, 'token', { kind: 'retry' }, NOW, rand)
    expect(m).toMatchObject({ attempt: 1, inFlight: false, nextAttemptAt: NOW + 30_000 })
    m = applyEnrollOutcome(m, 'token', { kind: 'retry' }, NOW, rand)
    expect(m.nextAttemptAt).toBe(NOW + 120_000)
    m = applyEnrollOutcome(m, 'token', { kind: 'retry', retryAfterMs: 5_000 }, NOW, rand)
    expect(m.nextAttemptAt).toBe(NOW + 5_000)
  })
  it('does not count unreachable against the backoff schedule but waits 6 hours', () => {
    const m = applyEnrollOutcome(
      { ...emptyEnrollMemory(), inFlight: true },
      'token',
      { kind: 'unreachable', retryAfterMs: ENROLL_UNREACHABLE_RETRY_MS },
      NOW,
      rand
    )
    expect(m).toMatchObject({ attempt: 0, nextAttemptAt: NOW + ENROLL_UNREACHABLE_RETRY_MS })
  })
  it('blocks SSO until the next sign-in and the token until the app updates', () => {
    expect(applyEnrollOutcome(emptyEnrollMemory(), 'sso', { kind: 'sso-stop' }, NOW, rand).ssoBlockedUntilSignIn).toBe(
      true
    )
    expect(applyEnrollOutcome(emptyEnrollMemory(), 'token', { kind: 'token-off' }, NOW, rand).tokenOff).toBe(true)
  })
})
