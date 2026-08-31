import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Source-contract lock for Tony's 2026-07-15 requirement: the Spotlight Ref button must ALWAYS route to
// the managed Dust agent and must NEVER be answered by whatever generic provider (e.g. Kimi) happens to be
// active. index.ts's attempt()/pickFailover are nested closures over the per-request IPC handler and are
// never unit-tested directly (there is no index.test.ts anywhere in this repo — same rationale that split
// out local-routing.ts and local-cloud-boundary.contract.test.ts), so the invariant is pinned here against
// the actual source. The behavioral half lives in local-routing.test.ts (allowCrossProviderFailover). This
// file guarantees index.ts is still WIRED to that predicate, and that the renderer still pins Spotlight Ref
// while leaving the generic follow-up cascade able to fail over — on every version.
const indexSrc = readFileSync(join(__dirname, 'index.ts'), 'utf8')
const appSrc = readFileSync(join(__dirname, '..', 'renderer', 'src', 'App.tsx'), 'utf8')

/** Slice from `marker` up to and including the first `followup.run(...)` / `ask.run(...)` call. */
function sliceCall(source: string, marker: string, call: string): string {
  const start = source.indexOf(marker)
  expect(start, `marker not found: ${marker}`).toBeGreaterThan(-1)
  const callStart = source.indexOf(call, start)
  expect(callStart, `call not found after ${marker}: ${call}`).toBeGreaterThan(-1)
  const end = source.indexOf(')', callStart)
  return source.slice(callStart, end + 1)
}

describe('pinned Dust-agent requests never fail over to a generic provider', () => {
  it('index.ts imports the failover-suppression predicate', () => {
    expect(indexSrc).toMatch(/import\s*\{[\s\S]*allowCrossProviderFailover[\s\S]*\}\s*from '\.\/llm\/local-routing'/)
  })

  it('pickFailover early-returns null for a pinned (agentOverride) request', () => {
    const start = indexSrc.indexOf('const pickFailover = (tried: ProviderId[], preferFree = false): ProviderId | null => {')
    expect(start).toBeGreaterThan(-1)
    const body = indexSrc.slice(start, start + 900)
    // The guard must come first — before any tier/candidate work — so BOTH seams that consult pickFailover
    // (the retry-budget sizing at hasFailoverTarget and the pre-token failover line) are covered at once.
    expect(body).toMatch(/if \(!allowCrossProviderFailover\(req\)\) return null/)
  })

  it('both failover seams still route through pickFailover (retry budget + pre-token hand-off)', () => {
    // hasFailoverTarget sizes the transient-retry budget from pickFailover; the pre-token failover line
    // does the actual hand-off. Both consult pickFailover, so a pinned request is suppressed at both
    // without the two being able to drift apart.
    expect(indexSrc).toMatch(/hasFailoverTarget = provider !== 'local' && !!pickFailover\(attempted\.concat\(provider\)\)/)
    // F3 hedge: this call now also forwards the optional race context (undefined outside a hedged ask) —
    // the pin is on the provider/preferFree args pickFailover-vs-failover parity actually depends on.
    expect(indexSrc).toMatch(/provider !== 'local' && failover\(attempted\.concat\(provider\), preferFree, race\)/)
  })

  it('the first-attempt local-fallback seam suppresses pinned requests too (not only pickFailover)', () => {
    // The zero-config safety net (first-attempt ineligibility → attempt('local')) bypasses pickFailover
    // entirely, so it must carry its own allowCrossProviderFailover guard: a pinned (agentOverride)
    // request must surface the reconnect-Dust message, never a substitute local answer. Today's only
    // agentOverride caller happens to use mode:'answer' (out of local scope), but the contract holds by
    // construction, not by that coincidence.
    expect(indexSrc).toMatch(
      /provider !== 'local' &&\s*\n\s*allowCrossProviderFailover\(req\) &&\s*\n\s*localFallbackEligibleFor\(req, s, tier, allowed\)/
    )
  })
})

describe('renderer pins Spotlight Ref to Dust but lets the generic follow-up cascade fail over', () => {
  it('spotlightRef forces BOTH the locked agent and the Dust provider', () => {
    const call = sliceCall(appSrc, 'const spotlightRef = useCallback', 'ask.run(')
    expect(call).toMatch(/agentOverride: refAgent/)
    expect(call).toMatch(/providerOverride: 'dust'/)
  })

  it('spotlightRef does not dead-end on dustListAgents / reconnect copy', () => {
    const start = appSrc.indexOf('const spotlightRef = useCallback')
    const end = appSrc.indexOf('const generateFollowup = useCallback', start)
    const body = appSrc.slice(start, end)
    const executable = body.replace(/^\s*\/\/.*$/gm, '')
    expect(executable).not.toMatch(/dustListAgents/)
    expect(executable.toLowerCase()).not.toMatch(/reconnect/)
  })

  it('generateFollowup drafts the email via the BASE Métis Dust agent (no agentOverride, failover-safe), else the active provider', () => {
    const call = appSrc.slice(
      appSrc.indexOf('const generateFollowup = useCallback'),
      appSrc.indexOf('const capture = useCallback')
    )
    // The email itself is the base Métis agent: providerOverride 'dust' with NO agentOverride, so a Dust
    // outage still fails over to a configured cloud provider rather than dead-ending.
    expect(call).toMatch(/followup\.run\(\{ mode: 'answer', prompt, providerOverride: 'dust' \}\)/)
    // No-Dust path: plain ask on the active provider — the email recap no longer HARD-requires Dust.
    expect(call).toMatch(/followup\.run\(\{ mode: 'answer', prompt \}\)/)
    // The email generation must NOT pin an agentOverride — Spotlight Ref is only the wins source, fetched
    // separately (below), never the drafter.
    expect(call).not.toMatch(/followup\.run\([^)]*agentOverride/)
  })

  it('Spotlight Ref is used ONLY to fetch the success stories, on its own pinned ask', () => {
    const wins = appSrc.slice(
      appSrc.indexOf('const fetchSpotlightWins = useCallback'),
      appSrc.indexOf('const generateFollowup = useCallback')
    )
    // The wins lookup is the ONLY place the email flow pins the Spotlight Ref agent.
    expect(wins).toMatch(/agentOverride: refAgent/)
    expect(wins).toMatch(/providerOverride: 'dust'/)
    // It is self-contained (its own id) so it never pollutes the live answer/suggest/follow-up streams.
    expect(wins).toMatch(/const id = `wins-\$\{Date\.now\(\)\}`/)
  })
})
