import { describe, expect, it } from 'vitest'
import {
  HIGH_MEMORY_WHISPER_IMPORT_MIN_FREE_MEMORY_BYTES,
  HIGH_MEMORY_WHISPER_IMPORT_MIN_TOTAL_MEMORY_BYTES,
  hasHighMemoryWhisperImportHeadroom,
  hasVadV2MemoryHeadroom,
  preferredFreshAsrEngine,
  VAD_V2_MIN_FREE_MEMORY_BYTES
} from './asr-hardware-preference'

const GIB = 1024 ** 3

describe('preferredFreshAsrEngine', () => {
  it.each([
    ['below 8 GiB', 4 * GIB, 'parakeet'],
    ['exactly 8 GiB', 8 * GIB, 'parakeet'],
    ['one byte above 8 GiB', 8 * GIB + 1, 'whisper'],
    ['16 GiB', 16 * GIB, 'whisper'],
    ['32 GiB', 32 * GIB, 'whisper']
  ] as const)('selects the fresh default for %s', (_label, totalMemoryBytes, expected) => {
    expect(preferredFreshAsrEngine(totalMemoryBytes)).toBe(expected)
  })

  it.each([undefined, null, NaN, Infinity, -Infinity, -1, 0, '16 GiB']) (
    'uses conservative Parakeet for invalid or unknown physical memory %s',
    (totalMemoryBytes) => {
      expect(preferredFreshAsrEngine(totalMemoryBytes)).toBe('parakeet')
    }
  )
})

describe('hasVadV2MemoryHeadroom', () => {
  it('admits whole-recording VAD only when the free-RAM floor is met', () => {
    expect(hasVadV2MemoryHeadroom(VAD_V2_MIN_FREE_MEMORY_BYTES - 1)).toBe(false)
    expect(hasVadV2MemoryHeadroom(VAD_V2_MIN_FREE_MEMORY_BYTES)).toBe(true)
  })

  it.each([undefined, null, NaN, Infinity, -Infinity, -1, 0, '3 GiB'])(
    'fails closed for invalid free-memory readings: %s',
    (freeMemoryBytes) => {
      expect(hasVadV2MemoryHeadroom(freeMemoryBytes)).toBe(false)
    }
  )
})

describe('hasHighMemoryWhisperImportHeadroom', () => {
  it.each([
    ['8 GiB device', 8 * GIB, HIGH_MEMORY_WHISPER_IMPORT_MIN_FREE_MEMORY_BYTES, false],
    ['12 GiB device', 12 * GIB, HIGH_MEMORY_WHISPER_IMPORT_MIN_FREE_MEMORY_BYTES, false],
    ['16 GiB device below the free-memory floor', 16 * GIB, HIGH_MEMORY_WHISPER_IMPORT_MIN_FREE_MEMORY_BYTES - 1, false],
    ['16 GiB device at both floors', 16 * GIB, HIGH_MEMORY_WHISPER_IMPORT_MIN_FREE_MEMORY_BYTES, true],
    ['more than 16 GiB at both floors', 32 * GIB, HIGH_MEMORY_WHISPER_IMPORT_MIN_FREE_MEMORY_BYTES, true]
  ] as const)('admits the optional high-memory Whisper import tier for %s only when both floors are met', (
    _label,
    totalMemoryBytes,
    freeMemoryBytes,
    expected
  ) => {
    expect(hasHighMemoryWhisperImportHeadroom(totalMemoryBytes, freeMemoryBytes)).toBe(expected)
  })

  it.each([undefined, null, NaN, Infinity, -1, '16 GiB'])('fails closed for invalid total memory: %s', (totalMemoryBytes) => {
    expect(hasHighMemoryWhisperImportHeadroom(totalMemoryBytes, HIGH_MEMORY_WHISPER_IMPORT_MIN_FREE_MEMORY_BYTES)).toBe(false)
  })

  it.each([undefined, null, NaN, Infinity, -1, '5 GiB'])('fails closed for invalid free memory: %s', (freeMemoryBytes) => {
    expect(hasHighMemoryWhisperImportHeadroom(HIGH_MEMORY_WHISPER_IMPORT_MIN_TOTAL_MEMORY_BYTES, freeMemoryBytes)).toBe(false)
  })
})
