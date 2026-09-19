export type FreshAsrEngine = 'parakeet' | 'whisper'

const EIGHT_GIB_BYTES = 8 * 1024 ** 3
const GIB_BYTES = 1024 ** 3

/**
 * VAD v2 needs the decoded recording in one contiguous Float32Array after buffering its decoder slabs.
 * The 90-minute cap is roughly 330 MiB, so the assembly peak briefly approaches two copies. The import
 * may also be using the roughly 1.6 GiB Whisper host, so require 3 GiB free before choosing that quality
 * path. The legacy decoder stays bounded to one slab.
 * `os.freemem()` is conservative on Windows, which is the safe direction for an import admission gate.
 */
export const VAD_V2_MIN_FREE_MEMORY_BYTES = 3 * 1024 ** 3

/**
 * The optional import-only Whisper large-v3-turbo tier carries roughly 1.6 GB of weights before ONNX,
 * Electron, VAD PCM, and speaker-enrichment overhead. It is therefore never selected just because its
 * downloaded files exist: a current import must have both a 16 GiB machine and 5 GiB free at decoder
 * admission. The bundled Whisper-base floor remains available on every other machine.
 */
export const HIGH_MEMORY_WHISPER_IMPORT_MIN_TOTAL_MEMORY_BYTES = 16 * GIB_BYTES
export const HIGH_MEMORY_WHISPER_IMPORT_MIN_FREE_MEMORY_BYTES = 5 * GIB_BYTES

/** Unknown or invalid free-memory readings choose the bounded import path, never the whole-recording VAD. */
export function hasVadV2MemoryHeadroom(freeMemoryBytes: unknown): boolean {
  return (
    typeof freeMemoryBytes === 'number' &&
    Number.isFinite(freeMemoryBytes) &&
    freeMemoryBytes >= VAD_V2_MIN_FREE_MEMORY_BYTES
  )
}

/** Unknown, invalid, or changing OS memory readings must choose the compact import tier. */
export function hasHighMemoryWhisperImportHeadroom(totalMemoryBytes: unknown, freeMemoryBytes: unknown): boolean {
  return (
    typeof totalMemoryBytes === 'number' &&
    Number.isFinite(totalMemoryBytes) &&
    totalMemoryBytes >= HIGH_MEMORY_WHISPER_IMPORT_MIN_TOTAL_MEMORY_BYTES &&
    typeof freeMemoryBytes === 'number' &&
    Number.isFinite(freeMemoryBytes) &&
    freeMemoryBytes >= HIGH_MEMORY_WHISPER_IMPORT_MIN_FREE_MEMORY_BYTES
  )
}

/** Fresh-setup preference only. Availability/language fallback is owned by a later runtime task. */
export function preferredFreshAsrEngine(totalMemoryBytes: unknown): FreshAsrEngine {
  if (typeof totalMemoryBytes !== 'number' || !Number.isFinite(totalMemoryBytes) || totalMemoryBytes <= 0) {
    return 'parakeet'
  }
  return totalMemoryBytes <= EIGHT_GIB_BYTES ? 'parakeet' : 'whisper'
}
