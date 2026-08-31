/**
 * Live-caption latency budget (docs/asr/QUALITY.md).
 *
 * Time-to-first-caption (TTFC) is speech-onset → first non-empty caption. Decode time is hardware-bound
 * and is not faked here. This module measures the SCHEDULING budget: how soon the capture path is
 * allowed to emit a first partial so Best quality does not sit behind the 6 s monologue cap.
 */

/** First streaming partial, milliseconds of filled speech (worklet + tests + bench). */
export const FIRST_PARTIAL_MS = 1200
export const FIRST_PARTIAL_SAMPLES = Math.round(16_000 * (FIRST_PARTIAL_MS / 1000))

/** Hard monologue cap the worklet still force-emits at (listen.ts WINDOW_SEC). */
export const LIVE_WINDOW_CAP_MS = 6000

/**
 * Scheduling TTFC: first partial emit + a stub decode. Best must not wait on the 6 s cap.
 * `decodeMs` is injected so a bench can time a real decode or a fixture.
 */
export function ttfcBudgetMs(args: { partialMs?: number; decodeMs: number }): number {
  return (args.partialMs ?? FIRST_PARTIAL_MS) + args.decodeMs
}

/** True when the Best-quality scheduling path is within the international-firm bar (< 2 s + decode). */
export function bestQualityFeelsLive(decodeMs: number): boolean {
  return ttfcBudgetMs({ decodeMs }) < LIVE_WINDOW_CAP_MS / 2
}
