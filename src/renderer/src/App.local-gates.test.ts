/**
 * App.local-gates.test.ts — source-contract test for the requireProvider(local?) gating scheme (see
 * App.tsx's own doc comment above requireProvider's definition). There is no component-test harness for
 * App.tsx anywhere in this repo, so — following local-prewarm.test.ts / local-routing.test.ts's
 * "structural proof" pattern (readFileSync + regex over the real source) — this pins two things so a
 * future edit can't silently regress them:
 *
 *  (a) The No-Decision Honk effect's gate must NOT reference localSuggestReady. The honk always fires
 *      suggest.run({ mode: 'answer', ... }) (buildNoDecisionPrompt is deliberately answer-shaped), and
 *      Métis Local never serves 'answer' mode — so gating on localSuggestReady would let a local-only
 *      setup through the check and then straight into a provider error.
 *
 *  (b) Every requireProvider(...) call site's task argument matches the LLM mode the surrounding code
 *      actually fires: 'suggest'/'summary'/'vision' only where the fired request is genuinely
 *      local-scoped; bare requireProvider() everywhere the fired request is cloud-only (mode 'answer',
 *      mode 'recap', or a call site that can fire either depending on runtime state).
 *
 * Anchors are function/branch names and JSX prop names, never line numbers, so reordering unrelated code
 * doesn't break this file.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const source = readFileSync(join(__dirname, 'App.tsx'), 'utf8')

// Returns the argument text of the FIRST requireProvider(...) call found after `anchor` in the source
// (e.g. "" for a bare call, or "'suggest'" for a scoped one). Throws loudly if the anchor or the call
// itself has gone missing, so a rename shows up as a broken test rather than a silently-skipped one.
function requireProviderArgAfter(anchor: string): string {
  const idx = source.indexOf(anchor)
  if (idx === -1) throw new Error(`App.local-gates.test.ts anchor not found (source moved?): ${anchor}`)
  const rest = source.slice(idx)
  const m = rest.match(/requireProvider\(([^)]*)\)/)
  if (!m) throw new Error(`no requireProvider(...) call found after anchor: ${anchor}`)
  return m[1].trim()
}

describe('No-Decision Honk gate (H2)', () => {
  // Isolate the effect body that actually fires the honk: from the introducing comment to the closing
  // of its useEffect. `}, [listen.lines])` is unique in the file (the honk's transcript-driven re-fire
  // is the only effect keyed on exactly that dependency array), so it's a stable end anchor.
  const honkStart = source.indexOf('// No-Decision Honk')
  const honkEnd = source.indexOf('}, [listen.lines])', honkStart)

  it('anchors are present (source has not drifted out from under this test)', () => {
    expect(honkStart).toBeGreaterThan(-1)
    expect(honkEnd).toBeGreaterThan(honkStart)
  })

  const honkBlock = source.slice(honkStart, honkEnd)

  it('fires suggest.run with mode "answer" — confirms the fired mode this gate must protect', () => {
    expect(honkBlock).toMatch(/suggest\.run\(\{\s*mode:\s*'answer'/)
  })

  // Isolate the actual runtime gate condition (not the surrounding explanatory comments, which
  // legitimately name localSuggestReady to document why it's excluded) so this assertion tests the
  // code, not the prose.
  const gateLine = honkBlock.split('\n').find((l) => l.includes('settings?.autoSuggest'))

  it('gate condition line is present', () => {
    expect(gateLine).toBeTruthy()
  })

  it('gate condition does NOT reference localSuggestReady (local never serves answer mode)', () => {
    expect(gateLine).not.toMatch(/localSuggestReady/)
  })

  it('gate condition still requires settings.providerReady', () => {
    expect(gateLine).toMatch(/settings\?\.providerReady/)
  })
})

describe('requireProvider(local?) call-site contract (H1)', () => {
  it('askScreen fires ask.run({ mode: "vision", ... }) -> requireProvider(\'vision\')', () => {
    expect(requireProviderArgAfter('const askScreen = useCallback(')).toBe("'vision'")
  })

  it('answerNow fires suggest.run({ mode: "suggest", ... }) -> requireProvider(\'suggest\')', () => {
    expect(requireProviderArgAfter('const answerNow = useCallback(')).toBe("'suggest'")
  })

  it("onQuickAction's summarize branch always fires ask.run({ mode: 'summary' }) on its only non-screen, " +
      "non-error path -> requireProvider('summary')", () => {
    expect(requireProviderArgAfter("kind === 'summarize'")).toBe("'summary'")
  })

  it('assist can fall through to suggest.run({ mode: "answer" }) (capture failure / screenAsk off) -> stays bare', () => {
    expect(requireProviderArgAfter('const assist = useCallback(')).toBe('')
  })

  it('submit only ever fires mode "answer" directly (vision goes through askScreen\'s own gate) -> stays bare', () => {
    expect(requireProviderArgAfter('const submit = useCallback(')).toBe('')
  })

  it('factCheck only ever fires mode "answer" directly -> stays bare', () => {
    expect(requireProviderArgAfter('const factCheck = useCallback(')).toBe('')
  })

  it('whatNext can fire mode "answer" (no-transcript branch), not just "suggest" -> stays bare', () => {
    expect(requireProviderArgAfter('const whatNext = useCallback(')).toBe('')
  })

  it("onQuickAction's explain branch only ever fires mode \"answer\" directly -> stays bare", () => {
    expect(requireProviderArgAfter("kind === 'explain'")).toBe('')
  })

  it('onGenerateRecap fires generateSavedRecap -> mode "recap", always cloud -> stays bare', () => {
    expect(requireProviderArgAfter('onGenerateRecap=')).toBe('')
  })

  it('onRetryRecap fires generateSavedRecap -> mode "recap", always cloud -> stays bare', () => {
    expect(requireProviderArgAfter('onRetryRecap=')).toBe('')
  })
})

// r5 closure: the Summarize chip itself must be reachable for a local-only setup — App passes
// localSummaryReady into QuickActions, and QuickActions enables ONLY the summarize chip on it (the other
// three chips have direct answer-mode branches that only cloud serves).
describe('QuickActions local-summary reachability (r5)', () => {
  const appSrc = readFileSync(join(__dirname, 'App.tsx'), 'utf8')
  const qaSrc = readFileSync(join(__dirname, 'components', 'QuickActions.tsx'), 'utf8')

  it('App passes localSummaryReady into QuickActions', () => {
    expect(appSrc).toMatch(/localSummaryReady=\{settings\?\.localSummaryReady \?\? false\}/)
  })

  it('QuickActions enables only the summarize chip via localSummaryReady', () => {
    expect(qaSrc).toMatch(/providerReady \|\| \(a\.kind === 'summarize' && localSummaryReady\)/)
  })
})
