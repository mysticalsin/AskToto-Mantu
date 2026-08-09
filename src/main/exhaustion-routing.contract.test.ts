import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Source contract for the OmniRoute resilience integration in askStart — the wiring that turns "you ran
 * out of tokens/credit" into a kind-aware cooldown + a guaranteed backup, rather than a re-tried dead
 * provider and a misleading error. The behaviour is unit-tested in llm/exhaustion.test.ts,
 * llm/provider-health.test.ts and llm/usage-headroom.test.ts; askStart is a single large closure with no
 * injectable seam, so — like the other *.contract.test.ts beside it — the WIRING is pinned against source.
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

  it('a usage-cap message shows the reset time when the provider stated one', () => {
    expect(indexSrc).toMatch(/exhaustion\.resetAt[\s\S]{0,120}?toLocaleTimeString/)
  })
})

describe('the backup chain: free-first ordering + the on-device answer floor', () => {
  it('fails over preferring a free-tier backup when the primary ran OUT (not just any failure)', () => {
    expect(indexSrc).toMatch(/const preferFree = exhaustion != null && s\.resilience\.preferFreeOnExhaustion/)
    expect(indexSrc).toMatch(/failover\(attempted\.concat\(provider\), preferFree\)/)
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
