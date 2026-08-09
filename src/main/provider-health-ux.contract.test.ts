import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Source contract for the "your API key stopped working" path — MQA-003, MQA-004, MQA-005
 * (docs/qa/BUG-LEDGER.md).
 *
 * These three defects were found by physically driving the app with a revoked DeepSeek key
 * (scripts/qa/e2e-workflows.mjs, `--only=degrade`). The behavioral logic lives in
 * llm/provider-health.ts and is unit-tested there; what this file pins is that index.ts actually
 * CONSULTS it at every seam. A health tracker nothing calls would pass its own unit tests while the
 * user still waits 9s per ask behind a dead provider and still sees "403 status code (no body)".
 *
 * index.ts's askStart is a single ~300-line closure with no injectable seams, so — like
 * pinned-agent-boundary.contract.test.ts and ask-freshness.contract.test.ts beside it — the wiring is
 * asserted against the source text rather than by execution.
 */
const indexSrc = readFileSync(join(__dirname, 'index.ts'), 'utf8')

describe('MQA-004 — a rejected credential is recorded, not forgotten', () => {
  it('records an auth failure on a pre-token error', () => {
    expect(indexSrc).toMatch(/if \(!gotToken && isAuthFailure\(message\)\) recordAuthFailure\(provider, String\(message\)\)/)
  })

  it('clears the verdict the moment a provider produces a token', () => {
    // Inside the first-token branch of onDelta — proof the credentials work again.
    expect(indexSrc).toMatch(/if \(!gotToken\) \{[\s\S]{0,400}?recordSuccess\(provider\)/)
  })

  it('clears the verdict when the key changes, so pasting a working key visibly fixes it', () => {
    expect(indexSrc).toMatch(/setApiKey\(parsed\.provider, parsed\.key\)[\s\S]{0,600}?resetProviderHealth\(parsed\.provider\)/)
    expect(indexSrc).toMatch(/clearApiKey\(parsed\.provider\)\s*\n\s*resetProviderHealth\(parsed\.provider\)/)
  })

  it('exposes the unhealthy set to the renderer — providerReady alone cannot express "key is dead"', () => {
    expect(indexSrc).toMatch(/unhealthyProviders: unhealthyProviders\(\)/)
  })
})

describe('MQA-003 / MQA-021 — a dead provider is demoted, never re-tried first forever', () => {
  it('skips a cooling-down provider when choosing the FIRST provider to try', () => {
    expect(indexSrc).toMatch(/const skipDeadPrimary = isCoolingDown\(primary\) \? pickFailover\(\[primary\]\) : null/)
    expect(indexSrc).toMatch(/attempt\(skipDeadPrimary \?\? primary, skipDeadPrimary \? \[primary\] : \[\]\)/)
  })

  it('prefers a healthy candidate in the failover walk but still allows a cooling one as last resort', () => {
    // Two passes, not a filter: demoting must never become a hard block, or one revoked key would lock
    // a user out of the only provider they have configured.
    expect(indexSrc).toMatch(/order\.find\(\(p\) => eligible\(p\) && !isCoolingDown\(p\)\) \?\? order\.find\(eligible\)/)
  })

  it('a substituted primary stays in `attempted`, so the walk never circles back to it', () => {
    expect(indexSrc).toMatch(/skipDeadPrimary \? \[primary\] : \[\]/)
  })
})

describe('MQA-005 — the user is told what broke and what to do, not handed a raw provider string', () => {
  it('maps an auth rejection to an actionable message naming the provider and Settings', () => {
    expect(indexSrc).toMatch(/isAuthFailure\(message\)\s*\n?\s*\?\s*`\$\{def\.label\} rejected your API key/)
    expect(indexSrc).toMatch(/Open Settings → AI to re-enter it\./)
  })

  it('still keeps the distinct transient-network and Dust-session messages', () => {
    // Three different causes must not collapse into one message — sending a user to re-enter a
    // perfectly good key because their WiFi dropped is its own bug.
    expect(indexSrc).toMatch(/Connection issue — couldn't reach the provider after retrying/)
    expect(indexSrc).toMatch(/Your Dust session expired and could not refresh automatically/)
  })
})
