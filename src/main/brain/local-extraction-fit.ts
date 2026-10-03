import { LOCAL_CHARS_PER_TOKEN } from '../llm/local'

// ── Local context fit (M2-0430) ──────────────────────────────────────────────────────────────────────
// INV-FIT: when Métis Local serves extraction first, every request it is sent (extraction prompt, JSON
// reminder, transcript window and the reserved answer) fits one llama-server slot at LOCAL_CHARS_PER_TOKEN.
// A meeting that cannot be windowed that way is recorded exhausted without a model call; it is never sent
// to fail on the context size and never retried automatically.
export const LOCAL_EXTRACTION_OUTPUT_TOKENS = 1536
export const EXTRACTION_REMINDER = '\n\nREMINDER: your ENTIRE reply must be one valid JSON object. No fences, no prose.'
/** The user-turn wrapper around a window: file label, quoting, and the summary-mode framing (shared.ts). */
const EXTRACTION_USER_OVERHEAD_CHARS = 512
/** Chat-template tokens and tokenizer slack on top of the character estimate. */
const CONTEXT_MARGIN_TOKENS = 256
/** Below this a window holds a few lines at most: not a meaningful extraction. */
export const MIN_LOCAL_WINDOW_CHARS = 1000
/** Bounds the unattended model calls one meeting may cost on a small slot (the CPU profile's 4,096 tokens
 *  gives roughly 1,000-character windows); a longer meeting is recorded exhausted instead. */
const MAX_LOCAL_WINDOWS = 12

/** The largest window (chars) whose local extraction request, with a system prompt of `systemChars`,
 *  fits a slot of `slotTokens`, capped at `maxChars`. */
export function fitWindowChars(slotTokens: number, systemChars: number, maxChars: number): number {
  const promptTokens = Math.ceil((systemChars + EXTRACTION_USER_OVERHEAD_CHARS) / LOCAL_CHARS_PER_TOKEN)
  const windowTokens = slotTokens - LOCAL_EXTRACTION_OUTPUT_TOKENS - CONTEXT_MARGIN_TOKENS - promptTokens
  return Math.min(maxChars, Math.max(0, windowTokens * LOCAL_CHARS_PER_TOKEN))
}

/** A meeting whose extraction cannot fit the local model's context on this machine. Permanent for the
 *  current bytes and profile: finishJob records it exhausted, and only an explicit Retry resends it. */
export class ExtractionDoesNotFitError extends Error {
  constructor() {
    super(
      'This meeting does not fit the on-device model\'s context on this Mac, so it was not indexed. ' +
      'Select Retry after closing other apps, or index it with a cloud provider.'
    )
    this.name = 'ExtractionDoesNotFitError'
  }
}

/** Throws ExtractionDoesNotFitError unless every window fits `size` and the meeting stays within the
 *  window budget. splitIntoWindows keeps a line whole, so a single line longer than the slot still overflows. */
export function assertLocalWindowsFit(size: number, windows: readonly string[]): void {
  if (size < MIN_LOCAL_WINDOW_CHARS || windows.length > MAX_LOCAL_WINDOWS || windows.some((w) => w.length > size)) {
    throw new ExtractionDoesNotFitError()
  }
}

export function isContextOverflow(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /exceeds the available context size/i.test(message)
}
