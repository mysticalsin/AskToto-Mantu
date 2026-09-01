/**
 * Meeting ASR engine policy.
 *
 * Product law:
 *  1. Whisper is the default so a meeting always has a working engine when Parakeet weights are absent.
 *  2. After onboarding, import/listen use the installed high-accuracy Parakeet when those files exist.
 *  3. A failed first Parakeet decode must not latch a leftover queue onto Whisper-only while the
 *     high-accuracy model is still on disk.
 *
 * Apple Speech stays an explicit opt-in. Resolution is a pure function of the request + whether the
 * high-accuracy Parakeet files exist — never a process-wide leftover flag.
 */
export type AsrEngineId = 'whisper' | 'parakeet' | 'apple'

export interface ResolveAsrEngineInput {
  requested: AsrEngineId | string | null | undefined
  parakeetReady: boolean
}

/** Default working engine when Parakeet weights are missing. */
export const DEFAULT_ASR_ENGINE: AsrEngineId = 'whisper'

export function normalizeRequestedEngine(requested: ResolveAsrEngineInput['requested']): AsrEngineId {
  if (requested === 'parakeet' || requested === 'apple' || requested === 'whisper') return requested
  return DEFAULT_ASR_ENGINE
}

/**
 * Pick the engine for one meeting / one leftover import job.
 *
 * - Apple stays Apple (mac-only opt-in).
 * - High-accuracy Parakeet on disk → Parakeet (even when the schema default is Whisper).
 * - Otherwise → Whisper.
 */
export function resolveAsrEngine(input: ResolveAsrEngineInput): AsrEngineId {
  const requested = normalizeRequestedEngine(input.requested)
  if (requested === 'apple') return 'apple'
  if (input.parakeetReady) return 'parakeet'
  return DEFAULT_ASR_ENGINE
}

/**
 * Leftover / follow-on jobs re-resolve from disk. A prior decode failure is not an engine override.
 * Inventing a Whisper-only leftover flag here is the product FAIL this module exists to prevent.
 */
export function resolveLeftoverAsrEngine(input: ResolveAsrEngineInput & { lastParakeetDecodeFailed?: boolean }): AsrEngineId {
  void input.lastParakeetDecodeFailed
  return resolveAsrEngine(input)
}
