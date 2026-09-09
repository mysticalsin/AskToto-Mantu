import { describe, expect, it } from 'vitest'
import {
  ASR_EIGHT_GB_CLASS,
  WHISPER_BEST_MIN_ADVERTISED_RAM_GB,
  advertisedRamGB,
  effectiveWhisperQuality,
  freeRamGB,
  isEightGbClass,
  parakeetNumThreads,
  shouldPrewarmParakeet
} from './asr-ram'

describe('asr-ram — 8 GB laptop policy', () => {
  it('ceils marketed 8 GB from raw totalmem bytes (7.45–7.9 GiB class)', () => {
    expect(advertisedRamGB(8e9)).toBe(8)
    expect(advertisedRamGB(7.5 * 1024 ** 3)).toBe(8)
    expect(isEightGbClass(8)).toBe(true)
    expect(isEightGbClass(16)).toBe(false)
    expect(ASR_EIGHT_GB_CLASS).toBe(8)
  })

  it('forces Whisper Fast on ≤8 GB and under the Best floor, keeps Best on roomy machines', () => {
    const effective = effectiveWhisperQuality
    expect(effective('best', 8)).toEqual({ quality: 'fast', ramLimited: true })
    expect(effective('best', 10)).toEqual({ quality: 'fast', ramLimited: true })
    expect(effective('best', WHISPER_BEST_MIN_ADVERTISED_RAM_GB)).toEqual({
      quality: 'best',
      ramLimited: false
    })
    expect(effective('fast', 32)).toEqual({ quality: 'fast', ramLimited: false })
  })

  it('uses one Parakeet thread on 8 GB and two above', () => {
    expect(parakeetNumThreads(8)).toBe(1)
    expect(parakeetNumThreads(16)).toBe(2)
  })

  it('skips Parakeet prewarm when free RAM is tight on 8 GB', () => {
    const should = shouldPrewarmParakeet
    expect(should(1.0, 8)).toBe(false)
    expect(should(2.0, 8)).toBe(true)
    expect(freeRamGB(2 * 1024 ** 3)).toBeCloseTo(2, 5)
  })
})
