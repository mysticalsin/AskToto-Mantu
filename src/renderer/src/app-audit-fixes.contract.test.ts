/**
 * app-audit-fixes.contract.test.ts — regression cover for the App.tsx defects in docs/qa/BUG-LEDGER.md:
 * MQA-053, MQA-059, MQA-068, MQA-071, MQA-072, MQA-082, MQA-083, MQA-099. (MQA-066 is deliberately
 * uncovered — see the note above the MQA-068 block for why the renderer-only fix would not hold.)
 *
 * Two kinds of assertion live here, deliberately:
 *
 *  1. Behavioural, against the pure decision function App.tsx now exports (meetingSaveIsRedundant) —
 *     the one fix whose logic is a decision rather than a wiring change, so it gets real calls with
 *     real inputs, the way lib/listen.ts's helpers are tested.
 *  2. Structural, via readFileSync + regex over the real source. vitest runs the `node` environment with
 *     no jsdom anywhere in this repo, so a hook's ref guard, an IPC channel choice, a callback prop and a
 *     render branch can't be exercised — this follows the established proof pattern of
 *     App.local-gates.test.ts / app-disregard.contract.test.ts and pins each fix's shape instead.
 *
 * Anchors are function names and branch conditions, never line numbers, so unrelated reordering is safe.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { meetingSaveIsRedundant } from './App'

// Normalize CRLF → LF: this is a Windows checkout, so any anchor whose newline sits mid-string would
// never match against \r\n.
const source = readFileSync(join(__dirname, 'App.tsx'), 'utf8').replace(/\r\n/g, '\n')

/** Source slice from `start` up to (excluding) the next `end`. Throws loudly if either anchor moved. */
function blockBetween(start: string, end: string): string {
  const from = source.indexOf(start)
  if (from === -1) throw new Error(`app-audit-fixes.contract.test.ts anchor not found (source moved?): ${start}`)
  const to = source.indexOf(end, from + start.length)
  if (to === -1) throw new Error(`app-audit-fixes.contract.test.ts end anchor not found after "${start}": ${end}`)
  return source.slice(from, to)
}

/** Drops `//` comment lines, so a "don't do X" assertion tests the code and not the prose explaining it. */
function code(block: string): string {
  return block
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}

// MQA-066 (SignInWall's "Settings → Account" remedy is unreachable) is NOT fixed here and has no test:
// the renderer-side half — letting 'settings' through the gate and rendering Settings over the wall —
// opens a panel that cannot complete the remedy, because src/main/index.ts's settings:set handler starts
// with `if (!requireAuth()) return publicSettings()`, and requireAuth() is false in exactly the state
// that raises the wall. Typing the Azure client/tenant ID would silently not persist. The fix needs a
// main-side carve-out, in a file this change does not own.

describe('MQA-068 — the license enforcement switch no longer advertises a safe one-line flip', () => {
  // NOT a behavioural fix: enforcement stays compiled off (flipping it alone would ship a blocking gate
  // with no activation form, since that form is gated by Settings.tsx's own LICENSE_UI_ENABLED). What is
  // pinned here is the disclosure — the comment used to promise that flipping THIS constant restored
  // licensing "exactly as before", which is the trap that produced the drift in the first place.
  const block = blockBetween('// ── License enforcement master switch', 'const licenseEnforced')

  it('still ships with enforcement off', () => {
    expect(block).toMatch(/const LICENSE_ENFORCEMENT = false/)
  })

  it('names the paired Settings switch and drops the "flip this ONE constant" claim', () => {
    expect(block).toMatch(/LICENSE_UI_ENABLED/)
    expect(block).not.toMatch(/flip this ONE constant/)
  })

  it('states that a managed-config licenseGateEnabled is inert while the switch is off', () => {
    expect(block).toMatch(/managed-config/)
    expect(block).toMatch(/inert/)
  })
})

describe('MQA-071 — a meeting can only be persisted once, even inside the save round trip', () => {
  it('a second save of the same meeting is redundant while the first is still in flight', () => {
    const claimed = new Set<string>()
    const id = '1770000000000'
    // Keyless Stop → the live saver claims the meeting and starts its IPC write.
    expect(meetingSaveIsRedundant(12, id, '', claimed)).toBe(false)
    claimed.add(id)
    // Escape out of Review, then start the next session — both rescues fire before savedRef is pinned.
    // Without the claim these read savedRef === '' and each write the transcript again.
    expect(meetingSaveIsRedundant(12, id, '', claimed)).toBe(true)
    expect(meetingSaveIsRedundant(12, id, '', claimed)).toBe(true)
  })

  it('still skips a meeting the recap auto-save already pinned, and empty sessions', () => {
    expect(meetingSaveIsRedundant(12, '1770000000000', '1770000000000', new Set())).toBe(true)
    expect(meetingSaveIsRedundant(0, '1770000000000', '', new Set())).toBe(true)
  })

  it('never blocks a different meeting', () => {
    const claimed = new Set(['1770000000000'])
    expect(meetingSaveIsRedundant(3, '1770000009999', '', claimed)).toBe(false)
  })

  it('saveMeetingNow takes the claim before its first await and releases it only on give-up', () => {
    const block = blockBetween('const saveMeetingNow = useCallback(', 'const saveMeetingNowRef')
    const body = code(block)
    // Claimed synchronously — after the guard, before window.toto.saveTranscript is ever awaited.
    const claimAt = body.indexOf('claimedSavesRef.current.add(id)')
    const awaitAt = body.indexOf('await window.toto.saveTranscript')
    expect(claimAt).toBeGreaterThan(-1)
    expect(awaitAt).toBeGreaterThan(claimAt)
    // Released only where the retry ladder gives up, so a later rescue can still persist the meeting.
    const giveUp = blockBetween('if (attempt >= maxAttempts) {', 'return null')
    expect(giveUp).toMatch(/claimedSavesRef\.current\.delete\(id\)/)
  })
})

describe('MQA-072 — a refused recap write is never treated as a successful one', () => {
  const block = blockBetween('const owningId = recapGenId', '// Settled with an error, or with nothing at all')

  it('captures recallUpdateRecap’s result instead of discarding it', () => {
    expect(block).toMatch(/const r = await window\.toto\.recallUpdateRecap\(action\.file, action\.text\)/)
    // The bug verbatim: a bare await, so every {ok:false} fell through to the success path.
    expect(code(block)).not.toMatch(/^\s*await window\.toto\.recallUpdateRecap/m)
  })

  it('bails out on !ok BEFORE painting the recap in and releasing the target', () => {
    const body = code(block)
    const bail = body.indexOf('if (!r.ok)')
    const paint = body.indexOf('setPastMeeting((prev)')
    const release = body.indexOf('setRecapGenTarget(null)')
    expect(bail).toBeGreaterThan(-1)
    expect(paint).toBeGreaterThan(bail)
    expect(release).toBeGreaterThan(bail)
    // Releasing the target is what flips Review back to the still-empty saved recap and loses the only
    // copy of the generated text — the early return is the whole fix.
    expect(body.slice(bail, paint)).toMatch(/return\b/)
  })

  it('surfaces the failure instead of failing silently', () => {
    expect(block).toMatch(/setRecapSaveError\(r\.error \|\|/)
    expect(source).toMatch(/Couldn.t save this summary: \{recapSaveError\}/)
  })
})

describe("MQA-082 — a desk-tap zone bound to 'Hide / show Métis' can show again", () => {
  const block = blockBetween("} else if (a === 'hide') {", "} else if (a === 'reset')")

  it('the renderer hotkey router toggles the window rather than one-way hiding it', () => {
    expect(code(block)).toMatch(/void window\.toto\.toggle\(\)/)
    expect(code(block)).not.toMatch(/window\.toto\.hide\(\)/)
  })

  it('leaves the deliberate one-way dismissals (Escape, minimized pill) on hide()', () => {
    // Escape's own precedence ladder ends in a dismissal, and the pill's onHide is a dismissal too —
    // scoping the fix to the tap-dispatch branch is the point.
    expect(source).toMatch(/escapeRef\.current = \(\): void => \{/)
    expect(source.match(/window\.toto\.hide\(\)/g)?.length).toBeGreaterThanOrEqual(2)
  })
})

describe('MQA-083 — a mic change no longer kills Desk Tap Control silently', () => {
  const block = blockBetween('useTapControl({', '\n  })')

  it('passes onProfileMismatch, so the hook’s refusal to arm is actually reported', () => {
    expect(block).toMatch(/onProfileMismatch: \(\) => setTapMismatch\(true\)/)
  })

  it('clears the flag when the profile or the selected mic changes', () => {
    // useTapControl only ever reports a mismatch — it has no "matched again" callback, so a recalibration
    // would otherwise leave the warning up forever.
    expect(source).toMatch(/useEffect\(\(\) => setTapMismatch\(false\), \[tapCfg\?\.profile, settings\?\.micDeviceId\]\)/)
  })

  it('renders a recalibrate prompt naming where to do it', () => {
    expect(source).toMatch(/\{tapMismatch && view !== 'settings' && \(/)
    expect(source).toMatch(/Desk Tap Control is paused/)
    expect(source).toMatch(/Recalibrate it in\n\s*Settings → Audio\./)
  })
})

describe('MQA-099 — the double-capture guard is armed, not just cleared', () => {
  const block = blockBetween('const askScreen = useCallback(', 'const assist = useCallback(')

  it('guards on the ref, not on the transition-deferred `capturing` state', () => {
    const body = code(block)
    expect(body).toMatch(/if \(capturingRef\.current\) return null/)
    // The bug verbatim: the only guard was the state value, which two fast triggers both read as false.
    expect(body).not.toMatch(/if \(capturing\) return null/)
  })

  it('arms the ref before the first await and after the early returns', () => {
    const body = code(block)
    const arm = body.indexOf('capturingRef.current = true')
    const firstAwait = body.indexOf('await ')
    const providerGuard = body.indexOf("requireProvider('vision')")
    expect(arm).toBeGreaterThan(providerGuard) // arming above a bare `return null` would latch it forever
    expect(firstAwait).toBeGreaterThan(arm)
  })

  it('clears the ref in the finally that already clears the busy state', () => {
    const finallyBlock = block.slice(block.lastIndexOf('} finally {'))
    expect(finallyBlock).toMatch(/capturingRef\.current = false/)
    expect(finallyBlock).toMatch(/setCapturing\(false\)/)
  })

  it('drops `capturing` from the callback deps so the guard cannot go stale', () => {
    expect(source).toMatch(
      /\[ask\.run, requireProvider, settings\?\.backgroundScreenContext, settings\?\.providerReady, listen\]/
    )
  })
})

// ── MQA-053 / MQA-059 — a silently absorbed dead credential is now stated, not swallowed ─────────────
//
// Both rows are the same defect seen from two ends: a pre-token 401 on the active provider is
// non-transient, so index.ts fails over to a second keyed provider and returns BEFORE any streamError —
// the ask looks normal. providerReady is derived from "a key string exists" (store.ts's hasApiKey), never
// from whether the key works, so the setup CTA never fires and Settings keeps showing that provider as
// active with a key saved. Main already computed the honest signal (`unhealthyProviders`); until now no
// surface the user actually looks at consumed it.
describe('MQA-053 / MQA-059 — the user is told when the ACTIVE provider stopped working', () => {
  const block = blockBetween('const dead = (settings.unhealthyProviders ?? []).find(', '})()}')

  it('reads the honest health signal main already ships, not providerReady', () => {
    expect(code(block)).toMatch(/settings\.unhealthyProviders/)
    // providerReady cannot express "the key exists and is dead" — gating on it here would render nothing.
    expect(code(block)).not.toMatch(/settings\.providerReady/)
  })

  it('fires only for the provider Settings shows as active', () => {
    expect(code(block)).toMatch(/u\.provider === settings\.provider/)
  })

  it('fires only for reasons the user must act on, never a transient limit', () => {
    const body = code(block)
    expect(body).toMatch(/u\.reason === 'auth'/)
    expect(body).toMatch(/u\.reason === 'quota-exhausted'/)
    // A 60s rate limit and a self-resetting session cap are what "Backups & limits" already rides out.
    expect(body).not.toMatch(/'rate-limit'/)
    expect(body).not.toMatch(/'usage-cap'/)
  })

  it('names the provider, says another one is answering, and points at the exact setting', () => {
    expect(block).toMatch(/was rejected/)
    expect(block).toMatch(/out of credit/)
    expect(block).toMatch(/another provider/)
    expect(block).toMatch(/Settings → AI/)
    expect(block).toMatch(/openSettings\('ai'/)
  })

  it('offers a CLI provider the remedy that exists for it — reconnect, not "update your key"', () => {
    const body = code(block)
    expect(body).toMatch(/kind === 'cli'/)
    expect(body).toMatch(/Reconnect it/)
  })

  it('re-fetches settings when an ask stops streaming, so the notice is not deferred to a window focus', () => {
    const effect = blockBetween('const wasStreamingRef = useRef(false)', 'const followup = useAsk()')
    const body = code(effect)
    expect(body).toMatch(/if \(askStreaming \|\| suggestStreaming\)/)
    expect(body).toMatch(/wasStreamingRef\.current = true/)
    // Never on mount: useSettings already fetches there, and a mount-time refetch would be pure noise.
    expect(body).toMatch(/if \(!wasStreamingRef\.current\) return/)
    expect(body).toMatch(/void refresh\(\)/)
  })
})
