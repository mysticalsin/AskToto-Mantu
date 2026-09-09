/**
 * ASR RAM policy for Métis 1.9.x — keep Best transcript quality on 8 GB laptops without thrashing.
 *
 * Product rules:
 * - Parakeet (default) IS Best for European speech: one int8 model, ~600 MB, no Whisper-large needed.
 * - Whisper Best (large-v3-turbo / WebGPU) is for non-European / opt-in paths on roomier machines.
 * - On ≤8 GB advertised RAM, Whisper must stay on the Fast (base) path so Electron + OS + speaker-id fit.
 * - Pure helpers: inject total/free bytes so unit tests do not depend on the host machine.
 */

/** Marketed 8 GB class (ceil of totalmem) — Electron + Parakeet + OS must fit here. */
export const ASR_EIGHT_GB_CLASS = 8

/**
 * Whisper Best (large multilingual WebGPU) needs headroom above Electron + OS.
 * Below this, Best request is honored as Fast-running with an honest ramLimited flag.
 */
export const WHISPER_BEST_MIN_ADVERTISED_RAM_GB = 12

/** Skip Parakeet boot prewarm when free RAM is under this (Listen still loads on demand). */
export const PARAKEET_PREWARM_MIN_FREE_RAM_GB = 1.5

export function advertisedRamGB(totalBytes: number): number {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return 0
  return Math.ceil(totalBytes / 1024 ** 3)
}

export function freeRamGB(freeBytes: number): number {
  if (!Number.isFinite(freeBytes) || freeBytes <= 0) return 0
  return freeBytes / 1024 ** 3
}

export function isEightGbClass(advertisedGB: number): boolean {
  return advertisedGB > 0 && advertisedGB <= ASR_EIGHT_GB_CLASS
}

/**
 * Map a Whisper quality request onto what this machine can actually run.
 * Parakeet callers should not use this — Parakeet already satisfies Best on 8 GB.
 */
export function effectiveWhisperQuality(
  requested: 'best' | 'fast',
  advertisedGB: number
): { quality: 'best' | 'fast'; ramLimited: boolean } {
  if (requested === 'fast') return { quality: 'fast', ramLimited: false }
  if (advertisedGB < WHISPER_BEST_MIN_ADVERTISED_RAM_GB) {
    return { quality: 'fast', ramLimited: true }
  }
  return { quality: 'best', ramLimited: false }
}

/** 1 thread on 8 GB class so speaker-id + Chromium keep breathing room; 2 on roomier boxes. */
export function parakeetNumThreads(advertisedGB: number): 1 | 2 {
  return isEightGbClass(advertisedGB) ? 1 : 2
}

/** Boot prewarm is optional; Listen always loads. Avoid double-resident models when free RAM is tight. */
export function shouldPrewarmParakeet(freeGB: number, advertisedGB: number): boolean {
  const floor = isEightGbClass(advertisedGB)
    ? PARAKEET_PREWARM_MIN_FREE_RAM_GB
    : Math.min(1, PARAKEET_PREWARM_MIN_FREE_RAM_GB)
  return freeGB >= floor
}
