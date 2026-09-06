import { describe, it, expect } from 'vitest'
import { FIRST_PARTIAL_MS, LIVE_WINDOW_CAP_MS, bestQualityFeelsLive, ttfcBudgetMs } from './asr-latency'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('TTFC scheduling budget — Best must not wait on the 6s cap', () => {
  it('first partial is well under the live monologue cap', () => {
    expect(FIRST_PARTIAL_MS).toBeLessThan(LIVE_WINDOW_CAP_MS / 2)
    expect(FIRST_PARTIAL_MS).toBe(1200)
  })

  it('Best scheduling + a 400ms stub decode stays under 2s', () => {
    expect(ttfcBudgetMs({ decodeMs: 400 })).toBe(1600)
    expect(bestQualityFeelsLive(400)).toBe(true)
  })

  it('the worklet actually emits a first partial at FIRST_PARTIAL_SAMPLES (source contract)', () => {
    const src = readFileSync(join(__dirname, '../renderer/src/lib/whisper-worklet-src.ts'), 'utf8')
    expect(src).toMatch(/PARTIAL_SAMPLES/)
    expect(src).toMatch(/partial: true/)
    expect(src).toMatch(/emitPartial/)
  })
})
