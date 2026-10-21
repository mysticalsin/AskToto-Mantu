// ── Whisper 'auto' language probe (PROVEN FACT 2026-08-05, direct probe): transformers.js's whisper NEVER
// auto-detects on an un-pinned decode — it logs "No language specified - defaulting to English" and
// decodes ENGLISH regardless of what was actually spoken. So asrLanguage:'auto' needs a language-agnostic
// signal to pin off, exactly like the import path (main/whisper-import.ts) was just fixed to use: Parakeet
// takes no `language` option, so its output reflects what was actually said. Probe early/periodic 'them'
// or 'you' windows through window.toto.parakeetFeed (main-side, bundled on both platforms) alongside the
// whisper decode — fire-and-forget, never blocking — and once shared/lang-id.ts confidently identifies the
// audio, post the worker a 'pinLanguage' message (see whisper.worker.ts's block comment for the invariants
// that message latches: never un-pin once pinned; explicit settings languages are never probed at all).
export const PROBE_WINDOW_BUDGET = 5 // probe EVERY one of the opening windows this densely, then drop to PROBE_EVERY
export const PROBE_MIN_WORDS = 8 // a near-empty window ("Hello") can only mislead — wait for real substance
// 1B.2c — shouldProbeLanguageWindow already keeps probing forever past PROBE_WINDOW_BUDGET when no pin
// has landed (see its own block comment), but every one of those probes still had to clear PROBE_MIN_WORDS
// (8) — a meeting whose opening minute is entirely short utterances ("Sim.", "Tá bom.", "Oi, oi.") never
// produces a single qualifying window, so the FIRST pin could be delayed indefinitely even though the
// probe cadence itself never gave up. Once the opening budget is spent with no pin yet, lower the bar for
// that FIRST pin only (a shakier signal beats staying wrongly latched to English for the rest of the
// meeting) — see probeMinWords below. Once pinned, re-probes go back to the normal, stricter gate.
export const PROBE_MIN_WORDS_AGGRESSIVE = 5
export const PROBE_EVERY = 2 // once pinned, re-probe often enough to catch a mid-meeting / mid-sentence switch
export const SWITCH_AFTER = 2 // consecutive confirming re-probes required before actually re-pinning

/**
 * Exported for unit testing — the pure probe cadence behind pump() (see PROBE_EVERY's block comment).
 * The un-pinned budget is an opening BURST, not a retirement: a meeting whose first windows are short
 * openers ("Oi", "Tudo bem?") burns all five of them on returns the PROBE_MIN_WORDS substance gate throws
 * away, and a probe that never landed must keep trying — an un-pinned whisper decode is hard-coded to
 * English by transformers.js, so "give up and stay auto" silently means "transcribe the rest of a
 * Portuguese meeting as English". Falling back to the PROBE_EVERY cadence (not every window) keeps the
 * steady-state probe load identical to the already-pinned case.
 */
export function shouldProbeLanguageWindow(windowIndex: number, pinned: boolean): boolean {
  if (pinned) return windowIndex % PROBE_EVERY === 0
  return windowIndex <= PROBE_WINDOW_BUDGET || windowIndex % PROBE_EVERY === 0
}

/**
 * Exported for unit testing — the pure minimum-substance gate behind probeLanguageWindow (see
 * PROBE_MIN_WORDS_AGGRESSIVE's block comment above). Only the FIRST pin ever gets the lower bar: once
 * `pinned` is true this returns the normal, stricter PROBE_MIN_WORDS regardless of windowIndex, so a
 * genuine mid-meeting language switch still needs real substance to re-pin, exactly as before.
 */
export function probeMinWords(pinned: boolean, windowIndex: number): number {
  return !pinned && windowIndex > PROBE_WINDOW_BUDGET ? PROBE_MIN_WORDS_AGGRESSIVE : PROBE_MIN_WORDS
}

/**
 * Live language pin / re-pin confirmation (MQA-235 for live).
 *
 * Import already majority-votes before the first pin because window 0 is often a wrong-language
 * greeting. Live used to latch on the FIRST confident probe — an English "thanks for joining" on a
 * French call pinned English for the rest of the meeting. The INITIAL pin now needs the same
 * SWITCH_AFTER consecutive confirming detections as a mid-meeting switch.
 *
 * Returns the next switch-run state and whether the worker should be (re)pinned to `detected`.
 */
export function advanceLanguageProbe(args: {
  detected: string
  pinnedLang: string | null
  switchRun: { lang: string; count: number } | null
  switchAfter?: number
  /** Window itself contains the new language alongside another — counts as stronger switch evidence. */
  mixed?: boolean
}): { pinnedLang: string | null; switchRun: { lang: string; count: number } | null; shouldPin: boolean } {
  const switchAfter = args.switchAfter ?? SWITCH_AFTER
  // Mixed evidence only accelerates a MID-meeting switch — first pin still needs SWITCH_AFTER.
  const step = args.mixed && args.pinnedLang !== null && args.detected !== args.pinnedLang ? 2 : 1
  if (args.pinnedLang === null) {
    const run =
      args.switchRun && args.switchRun.lang === args.detected
        ? { lang: args.detected, count: args.switchRun.count + step }
        : { lang: args.detected, count: step }
    if (run.count >= switchAfter) {
      return { pinnedLang: args.detected, switchRun: null, shouldPin: true }
    }
    return { pinnedLang: null, switchRun: run, shouldPin: false }
  }
  if (args.detected === args.pinnedLang) {
    return { pinnedLang: args.pinnedLang, switchRun: null, shouldPin: false }
  }
  const run =
    args.switchRun && args.switchRun.lang === args.detected
      ? { lang: args.detected, count: args.switchRun.count + step }
      : { lang: args.detected, count: step }
  if (run.count >= switchAfter) {
    return { pinnedLang: args.detected, switchRun: null, shouldPin: true }
  }
  return { pinnedLang: args.pinnedLang, switchRun: run, shouldPin: false }
}

/**
 * Exported for unit testing — the pure staleness decision behind probeLanguageWindow's `.then` (see)
 * useListen below). A probe is a fire-and-forget IPC round trip with no timeout whose first call of a
 * session pays the multi-second sherpa model load (parakeetRelease frees it between meetings), so it can
 * still be in flight when the user stops and starts a new meeting. `live` alone cannot express that:
 * start() raises it again for the NEXT session, so a session-1 probe resolving inside session 2 passed
 * the guard and pinned session 2's freshly reset worker to session 1's language. The session epoch
 * stamped at dispatch is the identity that survives the round trip — the same primitive stop()'s drain
 * uses to refuse to clobber a session it no longer owns.
 */
export function probeResultIsStale(
  dispatchEpoch: number,
  currentEpoch: number,
  live: boolean,
  engine: 'whisper' | 'parakeet' | 'apple' | 'cloud',
  language: string
): boolean {
  return dispatchEpoch !== currentEpoch || !live || engine !== 'whisper' || language !== 'auto'
}
