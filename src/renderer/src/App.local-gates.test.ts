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

  it('whatNext gates on suggest (dominant transcript route is local-capable, r6)', () => {
    expect(requireProviderArgAfter('const whatNext = useCallback(')).toBe("'suggest'")
  })

  it('whatNext re-gates its cloud-only text route bare before firing mode "answer" (r6)', () => {
    // The answer-mode branch must keep a bare provider gate even after the suggest-scoped top gate
    // passed on localSuggestReady alone — the local model never serves answer mode.
    expect(source).toMatch(/route\.transport === 'text' && !requireProvider\(\)/)
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

// r5/r6 closure: the local-capable chips must be reachable for a local-only setup — App passes the
// per-task readiness flags into QuickActions, which enables ONLY the summarize chip (summary mode) and
// the whatnext chip (transcript route fires suggest mode); fact-check and explain keep the cloud gate
// because their direct branches all fire answer mode.
describe('QuickActions local reachability (r5/r6)', () => {
  const appSrc = readFileSync(join(__dirname, 'App.tsx'), 'utf8')
  const qaSrc = readFileSync(join(__dirname, 'components', 'QuickActions.tsx'), 'utf8')

  it('App passes localSummaryReady and localSuggestReady into QuickActions', () => {
    expect(appSrc).toMatch(/localSummaryReady=\{settings\?\.localSummaryReady \?\? false\}/)
    expect(appSrc).toMatch(/localSuggestReady=\{settings\?\.localSuggestReady \?\? false\}/)
  })

  it('QuickActions enables exactly the summarize and whatnext chips via their local flags', () => {
    expect(qaSrc).toMatch(/\(a\.kind === 'summarize' && localSummaryReady\)/)
    expect(qaSrc).toMatch(/\(a\.kind === 'whatnext' && localSuggestReady\)/)
    expect(qaSrc).not.toMatch(/a\.kind === 'factcheck' &&/)
    expect(qaSrc).not.toMatch(/a\.kind === 'explain' &&/)
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
  const summarizeCanUseScreenLine = source
    .slice(summarizeIdx, source.indexOf('const route = chooseQuickActionRoute', summarizeIdx))
    .split('\n')
    .find((l) => l.includes('const canUseScreen'))

  const explainIdx = source.indexOf("kind === 'explain'")
  const explainCanUseScreenLine = source
    .slice(explainIdx, source.indexOf('const route = chooseQuickActionRoute', explainIdx))
    .split('\n')
    .find((l) => l.includes('const canUseScreen'))

  it('summarize\'s canUseScreen requires providerReady || localVisionReady (what askScreen actually gates on)', () => {
    expect(summarizeCanUseScreenLine).toMatch(/settings\?\.providerReady \|\| settings\?\.localVisionReady/)
    expect(summarizeCanUseScreenLine).not.toMatch(/settings\?\.visionAvailable/)
  })

  it('explain\'s canUseScreen is untouched (still the broader settings.visionAvailable)', () => {
    expect(explainCanUseScreenLine).toMatch(/settings\?\.visionAvailable/)
  })
})

describe('Speculative (showSpec) suggestion auto-dismiss (finding 4)', () => {
  // The two pre-existing dismiss effects key on suggest.answer only; whatNext's instant path can show
  // speculative.answer via showSpec without ever touching suggest.answer, so a second, mirrored pair keyed
  // on showSpec itself is required to honor the same SUGGESTION_TTL_MS/SUGGESTION_MAX_MS contract.
  const machineryBlock = blockBetween(
    '// Instant-suggestion machinery',
    'const whatNext = useCallback('
  )

  it('a TTL effect keyed on showSpec dismisses the speculative suggestion once it stops streaming', () => {
    expect(machineryBlock).toMatch(/if \(!showSpec \|\| !speculative\.answer \|\| speculative\.answer\.streaming\) return/)
    expect(machineryBlock).toMatch(/setTimeout\(\(\) => setShowSpec\(false\), SUGGESTION_TTL_MS\)/)
  })

  it('a hard-ceiling effect keyed on showSpec fires regardless of streaming state', () => {
    expect(machineryBlock).toMatch(/setTimeout\(\(\) => setShowSpec\(false\), SUGGESTION_MAX_MS\)/)
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
