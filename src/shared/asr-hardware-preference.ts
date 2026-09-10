export type FreshAsrEngine = 'parakeet' | 'whisper'

const EIGHT_GIB_BYTES = 8 * 1024 ** 3

/** Fresh-setup preference only. Availability/language fallback is owned by a later runtime task. */
export function preferredFreshAsrEngine(totalMemoryBytes: unknown): FreshAsrEngine {
  if (typeof totalMemoryBytes !== 'number' || !Number.isFinite(totalMemoryBytes) || totalMemoryBytes <= 0) {
    return 'parakeet'
  }
  return totalMemoryBytes <= EIGHT_GIB_BYTES ? 'parakeet' : 'whisper'
}
