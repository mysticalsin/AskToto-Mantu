/**
 * app-audit-fixes.contract.test.ts — regression cover for the App.tsx defects in docs/qa/BUG-LEDGER.md:
 * MQA-053, MQA-059, MQA-066, MQA-068, MQA-071, MQA-072, MQA-082, MQA-083, MQA-099.
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
import { meetingSaveIsRedundant, tapProfileMismatch } from './App'

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

// MQA-066 — the renderer half. The note that used to sit here said this could not be fixed from the
// renderer alone, and it was right: letting 'settings' through the gate opens a panel that cannot
// complete the remedy, because settings:set starts with `if (!requireAuth()) return publicSettings()`
// and requireAuth() is false in exactly the state that raises the wall. That main-side carve-out now
// exists (auth.ts's ssoBootstrapAllowed + the narrowed patch in settings:set, pinned by
// auth.test.ts and index-audit-fixes.contract.test.ts), so the renderer half below completes it.
describe('MQA-066 — Settings is reachable from behind the sign-in wall', () => {
  it('renders Settings in place of the wall, the way the onboarding gate already does', () => {
    const wall = blockBetween('// Azure AD gate — blocks all use when SSO is configured OR enforced', '// Onboarding gate (first run)')
    expect(code(wall)).toMatch(/if \(view === 'settings'\) \{/)
    expect(code(wall)).toMatch(/\{settingsBody\}/)
    // The wall itself still renders for every other view — this is an escape, not a removal.
    expect(code(wall)).toMatch(/<SignInWall/)
  })

  it('hands the wall a route to the screen its own remedy names', () => {
    const wall = blockBetween('// Azure AD gate — blocks all use when SSO is configured OR enforced', '// Onboarding gate (first run)')
    // Calendar, not Account: the Entra client/tenant/domain fields live on the Calendar tab, and there is
    // no Account tab at all — the old copy pointed at a screen that does not exist.
    expect(code(wall)).toMatch(/onOpenSettings=\{\(\) =>\s*\n?\s*openSettings\('calendar'/)
  })

  it("lets 'settings' — and only 'settings' — through the sign-in hotkey gate", () => {
    const gate = blockBetween('const onboardingGate = DEMO == null', 'if (a !== \'hide\' && minimized)')
    expect(code(gate)).toMatch(/if \(a !== 'hide' && \(onboardingGate \|\| \(signInGate && a !== 'settings'\)\)\) return/)
    // Onboarding keeps the stricter rule: there the widget genuinely is not usable yet.
    expect(code(gate)).not.toMatch(/onboardingGate && a !== 'settings'/)
  })
})

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
    const block = blockBetween('const saveMeetingNow = useCallback(', '// Same durable save, but for a meeting')
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
    expect(block).toMatch(/const outcome = await recapWriteCoordinatorRef\.current\.write/)
    expect(block).toMatch(/const r = outcome\.value/)
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

// MQA-083 closed the silent half (the hook's refusal to arm was reported at all). MQA-158 is what that
// first fix left behind: the report was latched in React state and cleared by an effect keyed on
// `tapCfg?.profile`, a nested object that arrives as a brand-new identity from EVERY settings read — the
// same IPC churn tap-control.ts absorbs with its string profileKey. So a window focus, the streaming→idle
// refresh, or any of the patches a live meeting writes on its own (asrLastFallbackAt, micOnlyFallbackAt)
// cleared the flag, while the hook — keyed on that stable string — never re-raised it. The amber banner
// vanished within seconds, Settings still said "Calibrated and ready.", and no desk tap ever worked again:
// the exact silently-dead-feature state MQA-083 exists to prevent. The banner's own comment already calls
// it "a standing state, not an event", so it is now DERIVED from the settings snapshot the hook reads,
// which cannot desynchronize from it.
describe('MQA-083 / MQA-158 — a mic change no longer kills Desk Tap Control silently', () => {
  const calibratedOn = (micDeviceId: string): { enabled: boolean; profile: { micDeviceId: string } } => ({
    enabled: true,
    profile: { micDeviceId }
  })

  it('MQA-158 — reports the mismatch whenever the selected mic is not the calibrated one', () => {
    expect(tapProfileMismatch(calibratedOn('default'), 'usb-headset')).toBe(true)
  })

  it('MQA-158 — survives a settings re-fetch that changes nothing but object identity', () => {
    const overIpc = JSON.parse(JSON.stringify(calibratedOn('default')))
    expect(tapProfileMismatch(overIpc, 'usb-headset')).toBe(true)
  })

  it('MQA-158 — is false in every state that genuinely resolves it', () => {
    expect(tapProfileMismatch(calibratedOn('usb-headset'), 'usb-headset')).toBe(false) // switched back
    expect(tapProfileMismatch(calibratedOn('usb-headset'), '')).toBe(false) // following the system default
    expect(tapProfileMismatch(calibratedOn('usb-headset'), undefined)).toBe(false)
    expect(tapProfileMismatch({ enabled: false, profile: { micDeviceId: 'default' } }, 'usb')).toBe(false)
    expect(tapProfileMismatch({ enabled: true, profile: null }, 'usb')).toBe(false) // never calibrated
    expect(tapProfileMismatch(undefined, 'usb')).toBe(false)
  })

  it('MQA-158 — the banner reads that derivation instead of a latched flag', () => {
    expect(source).toMatch(/const tapMismatch = tapProfileMismatch\(tapCfg, settings\?\.micDeviceId\)/)
    // Nothing left to clear out of band — the setState a routine settings re-fetch reset is gone, and with
    // it the need for a "matched again" callback the hook never had.
    expect(source).not.toMatch(/setTapMismatch/)
    expect(source).not.toMatch(/onProfileMismatch/)
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

  it('the streaming-to-idle refetch is RETIRED — the dead-key notice arrives on focus, not as a stinger (MQA-269)', () => {
    // This test used to pin the opposite: a force-refetch the instant a visible ask stopped streaming,
    // so the dead-key banner appeared immediately after the failover that had just answered correctly.
    // MQA-269 retired it deliberately — that timing turned a standing state into an event, narrating a
    // hop the user was never supposed to notice. The MQA-053/059 guarantee this file protects survives:
    // the notice still renders (asserted by the tests above) and still arrives, on the next natural
    // window-focus settings refresh. What must NOT come back is the refetch keyed to streaming state.
    expect(source).not.toMatch(/wasStreamingRef/)
    expect(source).toMatch(/retires the MQA-053\/MQA-059 force-refetch/)
  })
})

// MQA-216 — the "your organization restricts which providers you can use" sentence was reached by
// reading a saved API key as proof of an org policy, so the one state Cloudflare spends its whole
// first run in — key pasted, operator's Worker URL not yet pasted — told the user their employer had
// blocked them. Both surfaces that render it now test the allowlist itself and give the endpoint case
// its own remedy.
describe('MQA-216 — a missing endpoint URL is never reported as an org policy block', () => {
  for (const [name, block] of [
    ['the quick-action gate', blockBetween('const blockedByOrg =', 'return false')],
    ['the under-bar CTA', blockBetween('const activeDef = PROVIDERS[settings.provider]', 'return (')]
  ] as const) {
    it(`${name} decides "blocked" from allowedProviders, not from having a key`, () => {
      const body = code(block)
      expect(body).toMatch(/allowedProviders/)
      expect(body).toMatch(/!settings.*allowedProviders.*includes\(/)
      // The exact misread: a stored key standing in for an org policy.
      expect(body).not.toMatch(/blockedByOrg =\s*!*settings\??\.?hasApiKey/)
    })

    it(`${name} sends a provider whose endpoint the user supplies to the field that fixes it`, () => {
      const body = code(block)
      expect(body).toMatch(/requiresUserBaseUrl\(/)
      expect(body).toMatch(/providerBaseUrl\(/)
      expect(body).toMatch(/No endpoint URL set for/)
      expect(body).toMatch(/Settings → Advanced/)
    })
  }
})
