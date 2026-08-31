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

  it('gate condition does NOT reference localSuggestReady (that flag is the suggest-mode opt-in)', () => {
    expect(gateLine).not.toMatch(/localSuggestReady/)
  })

  it('gate condition does NOT reference localFallbackReady either — the honk never volunteers local work', () => {
    // The safety net WOULD serve this request (see the answer-floor block below), so this is a deliberate
    // product choice rather than a routing limit: the honk is the one request the user never asked for,
    // and an unprompted multi-second sidecar inference is the wrong thing to spend on a machine small
    // enough to be running the on-device model in the first place.
    expect(gateLine).not.toMatch(/localFallbackReady/)
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

  it('whatNext gates on suggest (dominant transcript route is local-capable, r6)', () => {
    expect(requireProviderArgAfter('const whatNext = useCallback(')).toBe("'suggest'")
  })

  it('whatNext re-gates its cloud-only text route bare before firing mode "answer" (r6)', () => {
    // The answer-mode branch must keep its own provider gate even after the suggest-scoped top gate
    // passed on localSuggestReady alone: that flag is the suggest-mode opt-in and proves nothing about
    // answer mode. The bare call is not "cloud only" — it still passes on the safety net (below).
    expect(source).toMatch(/route\.transport === 'text' && !requireProvider\(\)/)
  })

  it("onQuickAction's explain branch only ever fires mode \"answer\" directly -> stays bare", () => {
    expect(requireProviderArgAfter("kind === 'explain'")).toBe('')
  })

  it('onGenerateRecap fires generateSavedRecap (local-capable summary) -> requireProvider(\'summary\')', () => {
    expect(requireProviderArgAfter('onGenerateRecap=')).toBe("'summary'")
  })

  it('onRetryRecap fires generateSavedRecap (local-capable summary) -> requireProvider(\'summary\')', () => {
    expect(requireProviderArgAfter('onRetryRecap=')).toBe("'summary'")
  })
})

/**
 * The zero-API-key install has to work, because it is the install Métis Local exists for.
 *
 * Two different local flags decide that, and conflating them is what broke it. The per-task useFor
 * toggles (localSuggestReady / localSummaryReady / localVisionReady) are narrow: they say "prefer local
 * FIRST for this mode", and they only exist for the three modes local is scoped to. The safety net
 * (localFallbackReady) is the floor, and main's routing floor — localAnswerFloorEligibleFor in
 * local-routing.ts — deliberately ignores mode and tier entirely: when no cloud/CLI route can answer, a
 * weak on-device answer beats an error, answer and recap included.
 *
 * The renderer used to accept the net only inside the three in-scope branches, so a bare
 * requireProvider() — every typed question, fact-check and explain — returned false on a local-only
 * install and pushed the user to Settings to "add an API key", for a request main would have answered
 * on-device. The key-prompt CTA had the same hole and nagged permanently. Both are pinned below.
 */
describe('QuickActions and gate reachability for a zero-API-key install', () => {
  const appSrc = readFileSync(join(__dirname, 'App.tsx'), 'utf8')
  const qaSrc = readFileSync(join(__dirname, 'components', 'QuickActions.tsx'), 'utf8')

  it('App passes the per-task readiness flags AND localFallbackReady into QuickActions', () => {
    expect(appSrc).toMatch(/localSummaryReady=\{settings\?\.localSummaryReady \?\? false\}/)
    expect(appSrc).toMatch(/localSuggestReady=\{settings\?\.localSuggestReady \?\? false\}/)
    expect(appSrc).toMatch(/localFallbackReady=\{settings\?\.localFallbackReady \?\? false\}/)
  })

  it('the safety net enables EVERY chip, unconditioned on kind', () => {
    // Fact-check and Explain fire answer mode, which the floor serves. Leaving them dim on a local-only
    // install refused a request main would have taken, and the tooltip told the user to go get a key.
    expect(qaSrc).toMatch(/const localServes =\s*\n\s*localFallbackReady \|\|/)
  })

  it('the per-task flags stay narrow — only the two in-scope chips', () => {
    expect(qaSrc).toMatch(/a\.kind === 'summarize' && localSummaryReady/)
    expect(qaSrc).toMatch(/a\.kind === 'whatnext' && localSuggestReady/)
    expect(qaSrc).not.toMatch(/a\.kind === 'factcheck' && localS/)
    expect(qaSrc).not.toMatch(/a\.kind === 'explain' && localS/)
  })

  it('MQA-242: requireProvider passes on the safety net for ANY mode, including a bare call', () => {
    // The bare call is the typed-question path. This single clause is the fix: it sits outside the
    // per-task ternary, so it applies whether or not a task was named.
    expect(appSrc).toMatch(
      /if \(settings\?\.providerReady \|\| localTaskReady \|\| settings\?\.localFallbackReady\) return true/
    )
  })

  it('requireProvider still honours each per-task useFor toggle', () => {
    expect(appSrc).toMatch(/local === 'suggest'\s*\n\s*\? settings\?\.localSuggestReady/)
    expect(appSrc).toMatch(/\? settings\?\.localSummaryReady/)
    expect(appSrc).toMatch(/\? settings\?\.localVisionReady/)
  })

  it('the "add an API key" CTA is suppressed once the on-device model can answer', () => {
    // Not cosmetic: this banner is the app's own statement that it is not yet usable. Showing it to a
    // user whose local model answers every question is the app contradicting itself.
    expect(appSrc).toMatch(/!settings\.providerReady && !settings\.localFallbackReady && !nudgeExpired/)
  })
})

// Returns the source between two anchors (end exclusive), throwing loudly if either anchor has gone
// missing so a rename/reorder shows up as a broken test rather than a silently-skipped one.
function blockBetween(startAnchor: string, endAnchor: string): string {
  const start = source.indexOf(startAnchor)
  if (start === -1) throw new Error(`App.local-gates.test.ts anchor not found (source moved?): ${startAnchor}`)
  const end = source.indexOf(endAnchor, start)
  if (end === -1) throw new Error(`App.local-gates.test.ts end anchor not found after start: ${endAnchor}`)
  return source.slice(start, end)
}

// Fix-batch A_App findings (adversarially verified QA sweep, fixspecs/A_App.md). Each block below pins
// the SOURCE-OBSERVABLE contract of one fix so a future edit can't silently regress it.

describe('CRITICAL: follow-up draft cross-meeting leak (finding 6)', () => {
  // followup = useAsk() (the Review "Generate follow-up" draft) is a single instance shared across the
  // whole session. Every place that changes WHICH meeting is being viewed must clear it, or a draft
  // generated for meeting A can render/send as meeting B's follow-up.
  const startListenBlock = blockBetween('const startListen = useCallback(', 'const endReview = useCallback(')
  const resetBlock = blockBetween('const reset = useCallback(', 'const discardMeeting = useCallback(')
  const openPastMeetingBlock = blockBetween('const openPastMeeting = useCallback(', 'const resumePastMeeting = useCallback(')

  it('startListen (New meeting / toggle-listen / resume) clears followup', () => {
    expect(startListenBlock).toMatch(/followup\.clear\(\)/)
  })

  it('reset (hotkey reset / Disregard) clears followup', () => {
    expect(resetBlock).toMatch(/followup\.clear\(\)/)
  })

  it('openPastMeeting (History row / Recent-meetings / Related panel / Settings list) clears followup', () => {
    expect(openPastMeetingBlock).toMatch(/followup\.clear\(\)/)
  })
})

describe('Disregard-vs-autosave race (finding 7)', () => {
  const autosaveBlock = blockBetween('// auto-save the meeting to the OneDrive folder', '// record a completed Ask turn')
  const discardBlock = blockBetween('const discardMeeting = useCallback(', 'const clearAnswer = useCallback(')
  const startListenBlock = blockBetween('const startListen = useCallback(', 'const endReview = useCallback(')

  it('doSave records its in-flight promise so a concurrent Discard can await it', () => {
    expect(autosaveBlock).toMatch(/savingPromiseRef\.current = doSave\(\)/)
  })

  it('doSave resolves to the saved path (or null) instead of void, so the awaiter learns the outcome', () => {
    expect(autosaveBlock).toMatch(/const doSave = async \(\): Promise<string \| null> =>/)
    expect(autosaveBlock).toMatch(/return r\.path/)
  })

  it('discardMeeting awaits any in-flight save before deciding whether there is a file to delete', () => {
    expect(discardBlock).toMatch(/savingPromiseRef\.current \? await savingPromiseRef\.current : null/)
  })

  it('startListen resets savingPromiseRef so a prior meeting\'s settled promise can never leak into the next', () => {
    expect(startListenBlock).toMatch(/savingPromiseRef\.current = null/)
  })
})

describe('Log out refreshes auth.status (finding 8)', () => {
  const logOutBlock = blockBetween('const logOut = useCallback(', 'const onStop = useCallback(')
  // Isolate the actual executable lines (drop `//` comments, which legitimately name the bare IPC method
  // to document why it's no longer called directly) so this tests the code, not the prose.
  const logOutCode = logOutBlock
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')

  it('logOut calls the refreshing auth.signOut(), not the bare IPC method', () => {
    expect(logOutCode).toMatch(/await auth\.signOut\(\)/)
    expect(logOutCode).not.toMatch(/window\.toto\.signOut\(\)/)
  })
})

describe('Fact-check leftover-transcript fallthrough (finding 2)', () => {
  const factCheckBlock = blockBetween('const factCheck = useCallback(', 'const answerNow = useCallback(')

  it('the transcript-fed branch also fires when not listening but a transcript is present with no typed claim', () => {
    expect(factCheckBlock).toMatch(/if \(listen\.listening \|\| \(!claim && transcript\.trim\(\)\)\) \{/)
  })
})

describe('Summarize screen-route mirrors askScreen\'s actual vision gate (finding 3)', () => {
  // requireProviderArgAfter('summarize') anchors on the literal "kind === 'summarize'" text — reuse the
  // same anchor here, sliced up to the route computation, to isolate ONLY the summarize branch's
  // canUseScreen (explain's own separate canUseScreen, asserted below, must keep the broader flag).
  const summarizeIdx = source.indexOf("kind === 'summarize'")
  // canUseScreen here is now a multi-line Boolean(...), so grab the whole block up to the route decision.
  const summarizeCanUseScreenBlock = source.slice(
    summarizeIdx,
    source.indexOf('const route = chooseQuickActionRoute', summarizeIdx)
  )

  const explainIdx = source.indexOf("kind === 'explain'")
  const explainCanUseScreenLine = source
    .slice(explainIdx, source.indexOf('const route = chooseQuickActionRoute', explainIdx))
    .split('\n')
    .find((l) => l.includes('const canUseScreen'))

  it("summarize's canUseScreen mirrors askScreen's full requireProvider('vision') gate incl. localFallbackReady (MQA-130)", () => {
    // askScreen gates on requireProvider('vision'), which is providerReady || localVisionReady ||
    // localFallbackReady. summarize's canUseScreen must include ALL three or a zero-cloud Local-AI-fallback
    // user is wrongly told it can't read the screen (the old form omitted localFallbackReady — the audit bug).
    expect(summarizeCanUseScreenBlock).toMatch(
      /settings\?\.providerReady \|\| settings\?\.localVisionReady \|\| settings\?\.localFallbackReady/
    )
    expect(summarizeCanUseScreenBlock).not.toMatch(/canUseScreen = Boolean\(\(settings\?\.screenAsk \?\? true\) && settings\?\.visionAvailable/)
  })

  it('explain\'s canUseScreen is untouched (still the broader settings.visionAvailable)', () => {
    expect(explainCanUseScreenLine).toMatch(/settings\?\.visionAvailable/)
  })

  it('keeps the local screen-summary prompt on the base tier without transcript-driven escalation', () => {
    const summarizeBlock = source.slice(summarizeIdx, source.indexOf("kind === 'summarize'", summarizeIdx + 1))
    expect(summarizeBlock).toMatch(/settings\?\.localVisionReady\s*\?\s*LOCAL_SCREEN_SUMMARY_PROMPT/)
  })
})

describe('Speculative (showSpec) suggestion stays until click or a new question (finding 4)', () => {
  const machineryBlock = blockBetween(
    '// Instant-suggestion machinery',
    'const whatNext = useCallback('
  )

  it('does not arm a TTL or max-age timer on showSpec or suggest.answer', () => {
    expect(source).not.toMatch(/SUGGESTION_TTL_MS/)
    expect(source).not.toMatch(/SUGGESTION_MAX_MS/)
    expect(source).not.toMatch(/setTimeout\(\(\) => suggest\.clear\(\)/)
    expect(source).not.toMatch(/setTimeout\(\(\) => setShowSpec\(false\)/)
    expect(machineryBlock).not.toMatch(/setTimeout\(\(\) => setShowSpec\(false\)/)
  })

  it('a new live suggestion still replaces the speculative card', () => {
    expect(machineryBlock).toMatch(/if \(liveSuggestId\) setShowSpec\(false\)/)
  })

  it('click dismisses via clearAnswer and does not send the suggestion', () => {
    const clearAnswer = blockBetween('const clearAnswer = useCallback(', 'const toggleTranscript = useCallback(')
    expect(clearAnswer).toMatch(/suggest\.clear\(\)/)
    expect(clearAnswer).not.toMatch(/ask\.run|suggest\.run|submit/)
  })
})

describe('Retry button hidden when nothing is retryable (finding 1)', () => {
  it('onRetry is withheld whenever ask.answer has no replayable prompt (e.g. after ask.fail())', () => {
    expect(source).toMatch(/onRetry=\{capturing \|\| !ask\.answer\?\.prompt \? undefined : retryAnswer\}/)
  })
})

describe('openPastMeeting surfaces recallRead failures instead of a silent dead-end (finding 5)', () => {
  const openPastMeetingBlock = blockBetween('const openPastMeeting = useCallback(', 'const resumePastMeeting = useCallback(')

  it('a failed recallRead sets a visible error instead of bare-returning', () => {
    expect(openPastMeetingBlock).toMatch(/if \(!r\.ok\) \{/)
    expect(openPastMeetingBlock).toMatch(/setOpenMeetingError\(r\.error \|\| 'Could not open that meeting\.'\)/)
  })

  it('the error banner is rendered from openMeetingError state', () => {
    expect(source).toMatch(/\{openMeetingError && \(/)
  })
})
