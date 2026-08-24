import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BaseSettingsSchema, DEFAULT_SETTINGS, ASK_MEMORY_IDLE_MS } from '@shared/ipc'
import { isTransient } from './llm/retry'

// Source-contract lock for Tony's 2026-08-04 requirement: a plain typed/screen question asked OUTSIDE a
// live meeting must not inherit the previous question's Q&A ("it uses the old conversation info in the
// next question"). Cross-question state rides in TWO independent carriers — the renderer's history array
// and the server-side Dust conversation — so the boundary is enforced at main's single ask choke point
// (IPC.askStart), where both are cleared in the same breath. attempt()/the gate are nested closures over
// the per-request IPC handler and are never unit-tested directly (no index.test.ts exists — same rationale
// as pinned-agent-boundary.contract.test.ts), so the invariant is pinned here against the actual source.
const indexSrc = readFileSync(join(__dirname, 'index.ts'), 'utf8')
const appSrc = readFileSync(join(__dirname, '..', 'renderer', 'src', 'App.tsx'), 'utf8')
const onboardingSrc = readFileSync(
  join(__dirname, '..', 'renderer', 'src', 'components', 'OnboardingExperience.tsx'),
  'utf8'
)

describe('fresh-question boundary at the askStart choke point', () => {
  it('askFollowUpMemory defaults to OFF — every plain question starts clean unless the user opts in', () => {
    expect(BaseSettingsSchema.shape.askFollowUpMemory.parse(undefined)).toBe(false)
    expect(DEFAULT_SETTINGS.askFollowUpMemory).toBe(false)
  })

  it('the gate targets exactly the plain interactive surface: answer/vision, no overrides, not listening', () => {
    const start = indexSrc.indexOf('// Fresh-question boundary (see the state block above)')
    expect(start).toBeGreaterThan(-1)
    const body = indexSrc.slice(start, start + 1200)
    expect(body).toMatch(/req\.mode === 'answer' \|\| req\.mode === 'vision'/)
    expect(body).toMatch(/!req\.agentOverride/)
    expect(body).toMatch(/!req\.providerOverride/)
    expect(body).toMatch(/!listeningActive/)
  })

  it('the gate clears BOTH carriers together — renderer history and the server-side Dust conversation', () => {
    const start = indexSrc.indexOf('if (!s.askFollowUpMemory || Date.now() - lastPlainAskAt > ASK_MEMORY_IDLE_MS) {')
    expect(start).toBeGreaterThan(-1)
    const body = indexSrc.slice(start, start + 200)
    expect(body).toMatch(/req\.history = \[\]/)
    expect(body).toMatch(/resetDustConversation\(\)/)
  })

  it('opted-in follow-up memory still expires after idle (no unbounded carry-forward)', () => {
    expect(ASK_MEMORY_IDLE_MS).toBe(10 * 60 * 1000)
    expect(indexSrc).toMatch(/Date\.now\(\) - lastPlainAskAt > ASK_MEMORY_IDLE_MS/)
    expect(indexSrc).toMatch(/lastPlainAskAt = Date\.now\(\)/)
  })

  it('listeningState keeps the boundary suspended during a live meeting', () => {
    const start = indexSrc.indexOf('ipcMain.handle(IPC.listeningState')
    expect(start).toBeGreaterThan(-1)
    expect(indexSrc.slice(start, start + 300)).toMatch(/listeningActive = !!on/)
  })

  it('IPC.askResetContext resets the Dust conversation — "New chat" is no longer a no-op for Dust users', () => {
    const start = indexSrc.indexOf('ipcMain.handle(IPC.askResetContext')
    expect(start).toBeGreaterThan(-1)
    const body = indexSrc.slice(start, start + 300)
    expect(body).toMatch(/resetDustConversation\(\)/)
    expect(body).toMatch(/lastPlainAskAt = 0/)
  })
})

describe('review fixes (2026-08-04) stay wired', () => {
  it('flipping askFollowUpMemory is a conversation boundary in MAIN (Dust conversation + idle clock)', () => {
    const start = indexSrc.indexOf("if ('askFollowUpMemory' in p && next.askFollowUpMemory !== cur.askFollowUpMemory) {")
    expect(start).toBeGreaterThan(-1)
    const body = indexSrc.slice(start, start + 200)
    expect(body).toMatch(/resetDustConversation\(\)/)
    expect(body).toMatch(/lastPlainAskAt = 0/)
  })

  it('flipping askFollowUpMemory clears the RENDERER history refs (pre-opt-in Q&A never surfaces)', () => {
    const start = appSrc.indexOf('// Flipping follow-up memory is itself a conversation boundary')
    expect(start).toBeGreaterThan(-1)
    const body = appSrc.slice(start, start + 700)
    expect(body).toMatch(/historyRef\.current = \[\]/)
    expect(body).toMatch(/copilotHistoryRef\.current = \[\]/)
    expect(body).toMatch(/\}, \[settings\?\.askFollowUpMemory\]\)/)
  })

  it("screen-ask's stay-fast branch re-captures when history would be wiped (memory off or idle-expired)", () => {
    const start = appSrc.indexOf('const memoryLive =')
    expect(start).toBeGreaterThan(-1)
    const body = appSrc.slice(start, start + 400)
    expect(body).toMatch(/settings\?\.askFollowUpMemory \?\? false/)
    expect(body).toMatch(/ASK_MEMORY_IDLE_MS/)
    expect(appSrc).toMatch(/priorAnswerOk = !!ask\.answer\?\.text && !ask\.answer\.error && memoryLive/)
  })

  it('renderer and main share ONE idle-window constant', () => {
    expect(appSrc).toMatch(/import \{ DEFAULT_SHORTCUTS, ASK_MEMORY_IDLE_MS \} from '@shared\/ipc'/)
    expect(indexSrc).toMatch(/ASK_MEMORY_IDLE_MS,/)
  })
})

describe('renderer clears its own carriers at every conversation boundary', () => {
  it('reset() (New chat / Cmd+Shift+R) also resets the main-owned Dust conversation', () => {
    const start = appSrc.indexOf('const reset = useCallback(() => {')
    expect(start).toBeGreaterThan(-1)
    const body = appSrc.slice(start, appSrc.indexOf('}, [', start))
    expect(body).toMatch(/historyRef\.current = \[\]/)
    expect(body).toMatch(/copilotHistoryRef\.current = \[\]/)
    expect(body).toMatch(/window\.toto\.resetAskContext\(\)/)
  })

  it('startListen() clears ad-hoc history so pre-meeting Q&A never rides into mid-meeting asks', () => {
    const start = appSrc.indexOf('const startListen = useCallback(() => {')
    expect(start).toBeGreaterThan(-1)
    const body = appSrc.slice(start, appSrc.indexOf('}, [', start))
    expect(body).toMatch(/historyRef\.current = \[\]/)
    expect(body).toMatch(/copilotHistoryRef\.current = \[\]/)
  })
})

describe('key-exhaustion failover classification (the "Kimi maxed out → next key" path)', () => {
  // Pre-token, index.ts's onError fails over on ANY error once same-provider retries are exhausted
  // (transient → 1 bounded retry first; non-transient → immediate failover). These cases document the
  // classification for the quota shapes Tony's providers actually emit, so the waterfall reaches the
  // next configured key (Claude CLI, NIM, …) either way.
  it('a 429 rate-limit (OpenAI-SDK message shape, as Kimi emits) is transient → one retry, then failover', () => {
    expect(isTransient('429 Too Many Requests')).toBe(true)
    expect(isTransient('Rate limit reached for requests')).toBe(true)
  })

  it('a hard quota/plan-exhaustion message is NOT transient → immediate failover, no wasted retry', () => {
    expect(isTransient('403 insufficient_quota: You exceeded your current quota')).toBe(false)
    expect(isTransient('Your credit balance is too low to access the API')).toBe(false)
  })

  it('the pre-token failover seam hands ANY exhausted-retry error to the next provider', () => {
    // F3 hedge: this call now also forwards the optional race context (undefined outside a hedged ask).
    expect(indexSrc).toMatch(/if \(!gotToken && provider !== 'local' && failover\(attempted\.concat\(provider\), undefined, race\)\) return/)
  })

  it('the reasoning-only-no-answer case (Kimi burning its budget on thinking) stays pre-token → fails over', () => {
    // openai.ts routes it through onError; gotToken is only ever set by a CONTENT delta, so the failover
    // seam above still fires. Pin both halves.
    const openaiSrc = readFileSync(join(__dirname, 'llm', 'openai.ts'), 'utf8')
    expect(openaiSrc).toMatch(/sawReasoning && !usageResult\.sawContent/)
    // The load-bearing half is that `gotToken` is set ONLY by text that actually reaches the user, so a
    // reasoning-only response still hits the pre-token failover seam. That bookkeeping now lives in the
    // single `paint()` helper (onDelta and the onDone flush both go through it) rather than inline in
    // onDelta — a STRONGER version of the same rule, since paint() early-returns on empty text and the
    // think-stripper (llm/think-strip.ts) yields empty while a model is mid-<think>. Matched structurally
    // so the first-token block can keep carrying its other bookkeeping (the provider-health clear for
    // MQA-003/MQA-004, the hedge's declareWinner + winner streamMeta re-assert for MQA-143) without this
    // contract going stale. What must not change — and what the length assertion below locks — is that
    // nothing ELSE anywhere in index.ts assigns gotToken = true.
    expect(indexSrc).toMatch(
      /const paint = \(text: string\): void => \{\s*if \(!text\) return[\s\S]{0,1400}?gotToken = true/
    )
    // …and that every delta actually routes through it, rather than some provider painting directly.
    expect(indexSrc).toMatch(/onDelta: \(text\) => \{[\s\S]{0,400}?paint\(think\.push\(text\)\)/)
    const gotTokenAssignments = indexSrc.match(/gotToken = true/g) ?? []
    expect(gotTokenAssignments).toHaveLength(1)
  })
})

describe('onboarding fires the real OS permission flow proactively (max legitimate automation)', () => {
  it('macOS: setup-scene mount triggers the mic prompt + screen TCC registration without a button press', () => {
    const start = onboardingSrc.indexOf("if (scene !== 'setup') return")
    expect(start).toBeGreaterThan(-1)
    const body = onboardingSrc.slice(start, start + 4000)
    expect(body).toMatch(/window\.toto\.requestPermissionsUpfront\(\)/)
  })

  it('Windows: mic consent resolves via a renderer getUserMedia probe (main has no ask API off darwin)', () => {
    expect(onboardingSrc).toMatch(/getUserMedia\(\{ audio: true \}\)/)
  })
})
