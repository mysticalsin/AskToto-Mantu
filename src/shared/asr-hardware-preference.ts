export type FreshAsrEngine = 'parakeet' | 'whisper'

const EIGHT_GIB_BYTES = 8 * 1024 ** 3

/**
 * VAD v2 needs the decoded recording in one contiguous Float32Array after buffering its decoder slabs.
 * The 90-minute cap is roughly 330 MiB, so the assembly peak briefly approaches two copies. The import
 * may also be using the roughly 1.6 GiB Whisper host, so require 3 GiB free before choosing that quality
 * path. The legacy decoder stays bounded to one slab.
 * `os.freemem()` is conservative on Windows, which is the safe direction for an import admission gate.
 */
export const VAD_V2_MIN_FREE_MEMORY_BYTES = 3 * 1024 ** 3

/** Unknown or invalid free-memory readings choose the bounded import path, never the whole-recording VAD. */
export function hasVadV2MemoryHeadroom(freeMemoryBytes: unknown): boolean {
  return (
    typeof freeMemoryBytes === 'number' &&
    Number.isFinite(freeMemoryBytes) &&
    freeMemoryBytes >= VAD_V2_MIN_FREE_MEMORY_BYTES
  )
}

/** Fresh-setup preference only. Availability/language fallback is owned by a later runtime task. */
export function preferredFreshAsrEngine(totalMemoryBytes: unknown): FreshAsrEngine {
  if (typeof totalMemoryBytes !== 'number' || !Number.isFinite(totalMemoryBytes) || totalMemoryBytes <= 0) {
    return 'parakeet'
  }
  return totalMemoryBytes <= EIGHT_GIB_BYTES ? 'parakeet' : 'whisper'
}
