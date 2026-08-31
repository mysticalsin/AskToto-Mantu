/**
 * Onboarding-demo persistence guard (Act 2 safety rule, MQA-278) — mirrors the Vibe-Island teardown's
 * `isOnboardingDemo` + reserved-prefix allow-list idea, reimplemented for Métis's own boundary (own
 * naming, own mechanism — see docs/qa/BUG-LEDGER.md MQA-278 and the teardown PDF for the reference,
 * FEEL/architecture only).
 *
 * Act 2's onboarding demo (renderer/src/lib/onboarding-demo.ts) plays a scripted fake meeting through
 * the REAL Bar/Copilot/Answer components before the user has configured anything. It never calls a
 * real save/ingest IPC — by construction it has no access to `window.toto` or any real transcript/
 * session state (see onboarding-demo.ts's own header comment, and the "no real IPC" contract test that
 * pins this). This module is the belt-and-suspenders half: the two paths that ever write a "meeting" to
 * disk (`saveMeeting`, `saveNote` — main/transcripts.ts) and the one that feeds the private meeting
 * brain (`enqueueIngest` — main/brain/ingest.ts) call `refuseIfDemoTagged` as their first statement, so
 * ANY payload carrying the reserved tag below is refused before it can touch the real transcripts
 * folder or the real `.brain/` store — however it got there, including a future wiring mistake.
 *
 * This is content-based (a string prefix), not session-state-based, because main has no concept of
 * "is the onboarding demo on screen right now" — it only ever sees whatever payload a caller hands it.
 * The complementary renderer-side guard (renderer/src/lib/onboarding-demo-guard.ts) covers the other
 * half: while the demo scene is actually mounted, the real Answer component's own save/rate affordances
 * refuse to fire at all, tagged or not — see that module's header for why.
 */

/** Reserved marker. Chosen to be something no real user would ever type as a meeting title, mode, or
 *  note question — but still a plain, readable string (not an invisible/zero-width character) so a
 *  `grep`, log line, or test failure showing a rejected payload is legible rather than mysterious. */
export const ONBOARDING_DEMO_TAG = '__metis-onboarding-demo__:'

/** True if any of the given values is a string that carries the reserved onboarding-demo tag. Accepts
 *  `null`/`undefined` so callers can pass optional fields straight through without their own guards. */
export function isDemoTagged(...values: Array<string | null | undefined>): boolean {
  return values.some((v) => typeof v === 'string' && v.startsWith(ONBOARDING_DEMO_TAG))
}

/** Tag a string as onboarding-demo data. Used by the demo script (never by real code) so every piece of
 *  fake data it could ever hand to a real save/ingest path is provably, mechanically rejectable. */
export function tagAsDemo(value: string): string {
  return `${ONBOARDING_DEMO_TAG}${value}`
}

/** The actual gate. Call this as the FIRST statement of any function that persists a "meeting" — a
 *  demo-tagged payload throws here, before any file/IPC/settings work runs, so a caller cannot
 *  accidentally do partial work (e.g. create a folder, bump an index) before the refusal lands.
 *  `where` names the call site in the thrown message so a rejected save is traceable straight back to
 *  which guard caught it. */
export function refuseIfDemoTagged(where: string, ...values: Array<string | null | undefined>): void {
  if (!isDemoTagged(...values)) return
  throw new Error(
    `[demo-guard] ${where} refused: this payload is tagged as onboarding-demo data (Act 2's scripted ` +
      `fake meeting, see MQA-278) and must never reach real persistence.`
  )
}
