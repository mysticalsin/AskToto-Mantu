import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Source contract for two re-audit findings in askStart's stream handlers (MQA-101, MQA-102). askStart is
 * a single large closure with no injectable seam, so — like pinned-agent-boundary.contract.test.ts and
 * provider-health-ux.contract.test.ts beside it — the wiring is asserted against the source text. The
 * behaviour each fix relies on (isDustAuthError's phrasing coverage; the local no-output path) is unit-
 * tested in dust.test.ts and exercised physically; this pins that index.ts actually uses it.
 */
const indexSrc = readFileSync(join(__dirname, 'index.ts'), 'utf8')

describe('MQA-101 — a dead Dust session trips the circuit breaker and shows the reconnect prompt', () => {
  it('routes Dust credential-rejection detection through dust.ts isDustAuthError, not the generic matcher', () => {
    // The generic isAuthFailure has no pattern for Dust's current "authenticated credential" wording
    // (no 401 digits), so it never records the failure — the cooldown never trips. dust.ts maintains the
    // broadened matcher for exactly this drift.
    expect(indexSrc).toMatch(/provider === 'dust' \? isDustAuthError\(\{ message \}\) : isAuthFailure\(message\)/)
  })

  it('surfaces the Dust reconnect message via isDustAuthError, not a second inline phrasing regex', () => {
    // The old inline regex `authentication credential` never matched the current `authenticated
    // credential`, so a dead session leaked its raw 401 instead of the friendly reconnect prompt.
    expect(indexSrc).toMatch(/provider === 'dust' && isDustAuthError\(\{ message \}\)/)
    // …and the stale inline phrasing regex is gone.
    expect(indexSrc).not.toMatch(/oauth\|unauthor\|expired\|authentication credential/)
  })
})

describe('MQA-113 — the local fallback is preferred over a COOLING cloud provider in pickFailover', () => {
  it('picks a healthy provider, then local, then a cooling provider only as the absolute last resort', () => {
    const pf = indexSrc.slice(indexSrc.indexOf('const healthy = order.find'), indexSrc.indexOf('const healthy = order.find') + 2400)
    // 1) healthy non-cooling, in-budget provider first.
    expect(pf).toMatch(/const healthy = order\.find\(\(p\) => eligible\(p\) && !isCoolingDown\(p\) && !budgetBlocked\(p\)\)/)
    expect(pf).toMatch(/if \(healthy\) return healthy/)
    // 2) in-scope local fallback BEFORE the cooling-cloud last resort — this is the fix: a 2nd/Nth cooling
    //    provider must not be retried every ask ahead of the ready on-device model.
    const localIdx = pf.indexOf("localFallbackEligibleFor(req, s, tier, allowed)) return 'local'")
    const lastResortIdx = pf.indexOf('const coolingResort = order.find(eligible)')
    expect(localIdx).toBeGreaterThan(-1)
    expect(lastResortIdx).toBeGreaterThan(-1)
    expect(localIdx).toBeLessThan(lastResortIdx) // in-scope local is checked BEFORE the cooling last resort
  })
})

describe('MQA-102 — a local completion with zero content surfaces as an error, never a blank bubble', () => {
  it('sends a streamError for a pre-token local onDone instead of falling through to streamDone', () => {
    const start = indexSrc.indexOf('onDone: (u, completion) => {')
    const onDone = indexSrc.slice(start, indexSrc.indexOf('onError: failAttempt', start))
    // The cloud/CLI failover guard is explicitly `provider !== 'local'`, so local needs its own branch.
    expect(onDone).toMatch(/if \(!gotToken && provider === 'local'\) \{[\s\S]*?IPC\.streamError/)
    // And it must NOT failover (which could upload the request the user chose to keep on-device).
    const localBranch = onDone.slice(onDone.indexOf("provider === 'local'"))
    expect(localBranch.slice(0, 400)).not.toMatch(/failover\(/)
  })
})
