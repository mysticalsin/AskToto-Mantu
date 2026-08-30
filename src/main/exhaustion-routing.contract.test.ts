import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Source contract for the OmniRoute resilience integration in askStart — the wiring that turns "you ran
 * out of tokens/credit" into a kind-aware cooldown + a guaranteed backup, rather than a re-tried dead
 * provider and a misleading error. The behaviour is unit-tested in llm/exhaustion.test.ts,
 * llm/provider-health.test.ts and llm/usage-headroom.test.ts; askStart is a single large closure with no
 * injectable seam, so — like the other *.contract.test.ts beside it — the WIRING is pinned against source.
 *
 * Ledger rows this file pins (docs/qa/BUG-LEDGER.md):
 *   MQA-117 — a 429/rate-limit never tripped the breaker; the provider was re-tried as primary every ask.
 *   MQA-118 — hard credit/quota ("credit balance is too low") not remembered; re-paid every ask.
 *   MQA-119 — a claude-cli/subscription usage-cap surfaced its raw string and re-hit the cap every ask.
 *   MQA-120 — exhaustion with no backup showed a misleading "Connection issue" instead of the real limit.
 *   MQA-121 — the server Retry-After was ignored in the ask path.
 *   MQA-122 — answer mode had no on-device backup; it dead-ended with an error when the sole provider ran out.
 *   MQA-123 — pickFailover routed to the answer floor but attempt() bounced it (found by the physical sim).
 *   MQA-203 — a multi-day reset was phrased as a bare clock time, so a weekly cap read as "later today".
 */
const indexSrc = readFileSync(join(__dirname, 'index.ts'), 'utf8')

describe('exhaustion is classified first and drives a kind-aware cooldown', () => {
  it('classifies a pre-token, non-local failure through exhaustion.ts before the auth path', () => {
    expect(indexSrc).toMatch(
      /const exhaustion: ExhaustionSignal \| null =\s*\n?\s*!gotToken && provider !== 'local' \? classifyExhaustion\(message\) : null/
    )
  })

  it('a rate-limit records a timed back-off, honoring the server Retry-After', () => {
    expect(indexSrc).toMatch(/if \(exhaustion\.kind === 'rate-limit'\) recordRateLimited\(provider, exhaustion\.retryAfterMs\)/)
  })

  it('credit/usage-cap exhaustion is recorded as exhausted (long / reset-aware cooldown), not as a dead key', () => {
    expect(indexSrc).toMatch(/recordExhausted\(provider, exhaustion\.kind, \{/)
    expect(indexSrc).toMatch(/resetAt: exhaustion\.resetAt/)
  })

  it('a usage-cap does NOT retire the CLI — it is a temporary window, not a dead login', () => {
    expect(indexSrc).toMatch(/if \(!gotToken && !exhaustion\) retireCli\(provider, message\)/)
  })

  it('never records the on-device model as a credential rejection (privacy-bypass fix, MQA-124)', () => {
    // A local runtime error whose text matches isAuthFailure must not cool 'local' down — else the
    // skip-cooling-primary fast path would swap a privacy-pinned local vision request onto cloud.
    expect(indexSrc).toMatch(/const isCredentialRejection =\s*\n?\s*!exhaustion &&\s*\n?\s*provider !== 'local' &&/)
  })
})

describe('the retry vs fail-over decision respects the exhaustion kind', () => {
  it('a hard exhaustion (credit / usage-cap) is never retried in place', () => {
    expect(indexSrc).toMatch(/const hardExhaustion = exhaustion != null && exhaustion\.kind !== 'rate-limit'/)
    expect(indexSrc).toMatch(/!hardExhaustion &&/)
  })

  it('a rate-limit whose window is longer than a live ask can wait fails straight over instead', () => {
    expect(indexSrc).toMatch(/rateLimitTooLongToWait = rateLimitWaitMs != null && rateLimitWaitMs > MAX_ASK_RETRY_WAIT_MS/)
    expect(indexSrc).toMatch(/!rateLimitTooLongToWait/)
  })

  it('an in-place rate-limit retry honors the Retry-After window as the backoff floor', () => {
    expect(indexSrc).toMatch(/nextBackoff\(retryCount, \{ retryAfterMs: rateLimitWaitMs \?\? undefined \}\)/)
  })
})

describe('the user-facing message names the limit, not a misleading network error', () => {
  it('has a dedicated exhaustion message ladder (rate-limited / usage limit / out of credit)', () => {
    expect(indexSrc).toMatch(/const friendly = exhaustion/)
    expect(indexSrc).toMatch(/is rate-limited right now/)
    expect(indexSrc).toMatch(/hit its usage limit/)
    expect(indexSrc).toMatch(/is out of credit\./)
  })

  it('a usage-cap message shows WHEN it resets, day-aware, when the provider stated one (MQA-203)', () => {
    // Was pinned to a bare toLocaleTimeString, which locked in MQA-203: a weekly cap ~7 days out printed
    // only a clock time, so it read as "later today" and the user retried every morning for a week.
    expect(indexSrc).toMatch(/exhaustion\.resetAt[\s\S]{0,120}?formatResetPhrase\(exhaustion\.resetAt\)/)
  })
})

describe('the backup chain: free-first ordering + the on-device answer floor', () => {
  it('fails over preferring a free-tier backup when the primary ran OUT (not just any failure)', () => {
    expect(indexSrc).toMatch(/const preferFree = exhaustion != null && s\.resilience\.preferFreeOnExhaustion/)
    // F3 hedge: this call now also forwards the optional race context (undefined outside a hedged ask).
    expect(indexSrc).toMatch(/failover\(attempted\.concat\(provider\), preferFree, race\)/)
  })

  it('pickFailover floats free-tier providers ahead only when preferFree is set', () => {
    expect(indexSrc).toMatch(/if \(preferFree\) return \(PROVIDERS\[a\]\.freeTier \? 0 : 1\) - \(PROVIDERS\[b\]\.freeTier \? 0 : 1\)/)
  })

  it('the on-device answer floor is the DEAD-LAST hop, after even a cooling cloud provider', () => {
    const pf = indexSrc.slice(indexSrc.indexOf('const coolingResort = order.find(eligible)'))
    const coolingIdx = pf.indexOf('if (coolingResort) return coolingResort')
    const floorIdx = pf.indexOf('localAnswerFloorEligibleFor(req, s, allowed)) return')
    const nullIdx = pf.indexOf('return null')
    expect(coolingIdx).toBeGreaterThan(-1)
    expect(floorIdx).toBeGreaterThan(coolingIdx) // floor is offered AFTER the cooling last resort
    expect(nullIdx).toBeGreaterThan(floorIdx) // and only then does the walk dead-end
  })

  it('MQA-241: a FIRST-attempt ineligibility reaches the floor too, not just an exhausted provider', () => {
    // The third seam, and the one that was missed. MQA-122/123 fixed the floor for a provider that RAN
    // OUT mid-session; a provider that was never configured at all takes a different branch —
    // `attempted.length === 0`, which deliberately does not fail over — and that branch only offered the
    // in-scope net (localFallbackEligibleFor), which is false for answer/recap by design. So the single
    // most common request in the app, a typed question, dead-ended on "No API key for X. Open Settings
    // (gear) and add it." on exactly the install Métis Local exists for: local model on, no key.
    //
    // The call must go through failover(), not straight to attempt('local', ...). pickFailover ranks the
    // floor dead last, so a user whose ACTIVE provider is merely misconfigured still reaches their other
    // key or the actionable setup error, instead of being quietly downgraded to the on-device model.
    // Anchored on the zero-config net's own comment: `if (attempted.length === 0)` appears more than
    // once in askStart, and this is the branch that decides between local and the setup error.
    const anchor = 'Zero-config safety net (localLlm.fallback)'
    expect(indexSrc.indexOf(anchor), 'seam anchor not found (source moved?)').toBeGreaterThan(-1)
    const firstAttempt = indexSrc.slice(indexSrc.indexOf(anchor))
    const seam = firstAttempt.slice(0, firstAttempt.indexOf('} else if'))
    expect(seam).toMatch(/localAnswerFloorEligibleFor\(req, s, allowed\) &&\s*\n\s*failover\(attempted\.concat\(provider\), undefined, race\)/)
    // Still gated on the same pinned-agent rule as the in-scope net beside it.
    expect(seam).toMatch(/allowCrossProviderFailover\(req\) &&\s*\n\s*localAnswerFloorEligibleFor/)
    // And it must sit AFTER the in-scope net, so an in-scope mode keeps taking the direct local hop.
    expect(seam.indexOf('localFallbackEligibleFor')).toBeLessThan(seam.indexOf('localAnswerFloorEligibleFor'))
  })

  it('attempt() ACCEPTS the answer floor too — else pickFailover routes to local and attempt bounces it', () => {
    // The physical sim proved this: without localAnswerFloorEligibleFor in attempt()'s local ineligible
    // chain, an answer-mode failover to the floor was rejected with the "uses your cloud provider" message
    // instead of answering on-device. Both seams must agree on the floor.
    // localPrimaryEligibleFor (routingMode-aware) replaced bare localEligibleFor at this seam.
    const chain = indexSrc.slice(indexSrc.indexOf('const ineligible ='), indexSrc.indexOf('const ineligible =') + 700)
    expect(chain).toMatch(/localPrimaryEligibleFor\(req, s, tier, allowed\) \|\|/)
    expect(chain).toMatch(/localFallbackEligibleFor\(req, s, tier, allowed\) \|\|/)
    expect(chain).toMatch(/localAnswerFloorEligibleFor\(req, s, allowed\)/)
  })
})

describe('budget pre-emption skips a provider before it 429s (fail-open)', () => {
  it('folds isBudgetExhausted into the healthy filter, gated on the setting', () => {
    expect(indexSrc).toMatch(/const budgetBlocked = \(p: ProviderId\): boolean => s\.resilience\.budgetPreempt && isBudgetExhausted\(p\)/)
    expect(indexSrc).toMatch(/eligible\(p\) && !isCoolingDown\(p\) && !budgetBlocked\(p\)/)
  })

  it('skips a budget-exhausted primary at the entry point too', () => {
    expect(indexSrc).toMatch(/isCoolingDown\(primary\) \|\| \(s\.resilience\.budgetPreempt && isBudgetExhausted\(primary\)\)/)
  })
})
