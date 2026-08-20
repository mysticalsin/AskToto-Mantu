import { describe, expect, it } from 'vitest'
import { isProxyOperatorFault, isTransient, stripProxyFaultMarker } from './retry'

/**
 * A gateway (cloudflare-proxy/) reports "the OPERATOR's account token is dead" as a 502 — correctly,
 * because the caller's own key was accepted and answering 401 would send the user off to re-enter a
 * credential that works. But 502 also matches the transient-retry pattern, so on the terminal-error
 * path that failure used to be rewritten to "Connection issue — check your network": every user in the
 * org pointed at their wifi, while Settings → Test showed the true sentence at the same moment.
 *
 * The proxy now marks exactly the failures only IT can clear. The rule these tests protect: a marked
 * failure keeps its sentence; an unmarked 502 stays transient and keeps retrying.
 */
const OPERATOR_502 =
  '502 [metis-proxy-config] Cloudflare rejected this proxy account credential. The operator needs to check CLOUDFLARE_API_TOKEN and CF_ACCOUNT_ID.'
const UNCONFIGURED_503 =
  '503 [metis-proxy-config] This proxy is not configured. The operator must set CLOUDFLARE_API_TOKEN, CF_ACCOUNT_ID and METIS_PROXY_KEY.'
const TRANSIENT_502 = '502 Cloudflare AI is unavailable (upstream status 503).'

describe('gateway failures only the operator can fix', () => {
  it('recognises the two operator-fault shapes', () => {
    expect(isProxyOperatorFault(OPERATOR_502)).toBe(true)
    expect(isProxyOperatorFault(UNCONFIGURED_503)).toBe(true)
    expect(isProxyOperatorFault(new Error(OPERATOR_502))).toBe(true)
  })

  it('does NOT claim an ordinary upstream blip', () => {
    // The single most important negative. The proxy stamps its generic `metis_proxy_error` type on
    // transient failures too, so keying off that would turn a 30-second Cloudflare outage into a
    // "your operator misconfigured this" dead end. Only the explicit marker counts.
    expect(isProxyOperatorFault(TRANSIENT_502)).toBe(false)
    expect(isProxyOperatorFault('502 Bad Gateway')).toBe(false)
    expect(isProxyOperatorFault('Connection error.')).toBe(false)
    expect(isProxyOperatorFault(null)).toBe(false)
    expect(isProxyOperatorFault(undefined)).toBe(false)
  })

  it('leaves the transient classifier alone — an unmarked 502 still retries', () => {
    // The fix must not stop ordinary 5xx from being retried against the same provider.
    expect(isTransient(TRANSIENT_502)).toBe(true)
    expect(isTransient('502 Bad Gateway')).toBe(true)
  })

  it('shows the user the sentence without the routing marker', () => {
    const shown = stripProxyFaultMarker(OPERATOR_502)
    expect(shown).not.toContain('[metis-proxy-config]')
    expect(shown).toContain('The operator needs to check CLOUDFLARE_API_TOKEN')
    // and no double spacing left where the marker was
    expect(shown).not.toMatch(/ {2,}/)
  })

  it('stripping is safe on a message that was never marked', () => {
    expect(stripProxyFaultMarker(TRANSIENT_502)).toBe(TRANSIENT_502)
  })
})
