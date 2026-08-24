import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(__dirname, 'index.ts'), 'utf8')

describe('local processing privacy boundary', () => {
  it('forces an opted-in vision request onto local before provider overrides or cloud routing', () => {
    const start = source.indexOf('const localVisionRequired =')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, start + 800)
    expect(body).toMatch(/localVisionPrivacyRequired\(req, s\)/)
    expect(body).toMatch(/pickPrimaryProvider\([\s\S]*localVisionRequired[\s\S]*\)/)
  })

  it('reports a local screenshot readiness failure without claiming that cloud will handle it', () => {
    expect(source).toMatch(
      /localVisionRequired[\s\S]*Nothing was sent to a cloud provider/
    )
  })

  it('never sends a failed local request to a cloud failover provider', () => {
    const start = source.indexOf('onError: (message) => {')
    expect(start).toBeGreaterThan(-1)
    // Window widened again: the OmniRoute exhaustion-classification block (rate-limit / quota / usage-cap)
    // and the retry-window handling were inserted ahead of the failover line, pushing it further down. The
    // invariant is unchanged — local never fails over to cloud. `preferFree` is the free-first backup flag.
    const body = source.slice(start, start + 7_400)
    // F3 hedge: this call now also forwards the optional race context (undefined outside a hedged ask).
    expect(body).toMatch(/provider !== 'local' && failover\(attempted\.concat\(provider\), preferFree, race\)/)
  })

  // MQA-147: the F3 hedge leg is a FRESH dispatch, not a failover out of the local leg, so neither
  // `provider !== 'local'` guard above ever sees it. With the primary pinned on-device — a screenshot under
  // localVisionPrivacyRequired, or an in-scope local suggest — the HEDGE_DELAY_MS timer used to run
  // pickFailover([primary]) and start a keyed cloud provider carrying the unmodified req, base64 image
  // included. Aborting the loser afterwards does not un-send it. `primary !== 'local'` is the one conjunct
  // that closes both cases: with no race at all, the local leg's own terminal paths run un-suppressed and
  // the "Nothing was sent to a cloud provider" message is actually delivered instead of markDead-swallowed.
  it('MQA-147 — never hedge-races a local primary against a cloud provider', () => {
    const start = source.indexOf('const hedgeEligible =')
    expect(start).toBeGreaterThan(-1)
    const end = source.indexOf('if (hedgeEligible) {', start)
    expect(end).toBeGreaterThan(start)
    const gate = source.slice(start, end)
    expect(gate).toMatch(/primary !== 'local'/)
  })

  // TRUE RACE: whatever API is primary (Cloudflare or any other) starts TOGETHER with the on-device
  // model, and the fastest answer wins. The zero delay is keyed on the BACKUP being local — never on the
  // primary's identity — so it holds for every provider rather than being special-cased to one.
  // Quality is safe because HedgeRace declares the winner on FIRST TOKEN, not on start order.
  it('races the on-device model from t=0 against ANY api primary, not just one provider', () => {
    const at = source.indexOf('const hedgeDelayMs')
    expect(at).toBeGreaterThan(-1)
    const decl = source.slice(at, at + 160)
    // Keyed on the BACKUP, so no provider name appears in the condition.
    expect(decl).toMatch(/pickFailover\(\[primary\]\) === 'local' \? 0 : HEDGE_DELAY_MS/)
    expect(decl).not.toMatch(/cloudflare|anthropic|openai/)
    const timerAt = source.indexOf('startHedgeLeg()', at)
    expect(timerAt).toBeGreaterThan(at)
    expect(source.slice(timerAt, timerAt + 120)).toMatch(/\}, hedgeDelayMs\)/)
  })

  it('MQA-147 — a local primary therefore dispatches with no race, so its own guards still apply', () => {
    // The else branch of the hedge dispatch passes no AttemptRace, which is what makes index.ts's
    // `if (!race || race.gate.markDead(race.leg) === 'surface')` terminals actually surface for local.
    expect(source).toMatch(
      /\} else \{\s*[\s\S]{0,120}attempt\(skipDeadPrimary \?\? primary, skipDeadPrimary \? \[primary\] : \[\]\)/
    )
  })

  it('redacts the screen description before it crosses to a cloud provider (redactSensitive)', () => {
    // On macOS the pre-analyzed screen context can be a VERBATIM OCR extract (open password manager,
    // terminal with an API key). The injection into req.screenContext — which flows to whatever answer
    // provider is active, cloud included — must be built from the redacted local, never the raw field.
    // Anchored on the flag, not the full condition: MQA-009 widened the guard to
    // `req.mode === 'answer' && req.wantsScreenContext` so fact-check-on-screen stops being sent zero
    // screen data. The redaction invariant below is what this test exists to protect, and it is
    // independent of which asks reach the block.
    const start = source.indexOf('req.wantsScreenContext) {')
    expect(start).toBeGreaterThan(-1)
    const end = source.indexOf('} catch (err) {', start)
    expect(end).toBeGreaterThan(start)
    const body = source.slice(start, end)
    expect(body).toMatch(
      /const description = s\.redactSensitive \? redactSecrets\(ctx\.description\) : ctx\.description/
    )
    // From the assignment onward, only the redacted `description` local may be referenced — a future
    // edit reintroducing raw ctx.description into the assembled context must fail here.
    const assignIdx = body.indexOf('req.screenContext =')
    expect(assignIdx).toBeGreaterThan(-1)
    expect(body.slice(assignIdx)).not.toMatch(/ctx\.description/)
  })

  // MQA-009 (docs/qa/BUG-LEDGER.md): the screen-context injector used to sit INSIDE the
  // `kind !== 'factcheck'` gate that exists to keep brainContext away from fact-check, so
  // "fact-check what's on my screen" reached the model with no screen data at all. The two
  // injections are now siblings: brainContext stays fact-check-excluded, screenContext does not.
  it('injects screen context for fact-check too — only brainContext is fact-check-excluded (MQA-009)', () => {
    const screenIdx = source.indexOf('req.wantsScreenContext) {')
    const brainGateIdx = source.indexOf("req.mode === 'answer' && req.kind !== 'factcheck'")
    expect(screenIdx).toBeGreaterThan(-1)
    expect(brainGateIdx).toBeGreaterThan(-1)

    // The screen block must NOT be nested inside the brainContext gate. Its guard carries no
    // factcheck exclusion of its own.
    const screenGuard = source.slice(source.lastIndexOf('if (', screenIdx), screenIdx + 30)
    expect(screenGuard).not.toMatch(/factcheck/)
  })
})
