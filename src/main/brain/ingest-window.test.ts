import { describe, expect, it } from 'vitest'
import {
  buildExtractionSystem,
  fitWindowChars,
  localExtractionWindowChars,
  splitIntoWindows
} from './ingest'

const EXTRACTION_REMINDER = '\n\nREMINDER: your ENTIRE reply must be one valid JSON object. No fences, no prose.'

describe('M2-0034 extraction window sizing', () => {
  it('derives local extraction windows from the per-slot context, not the legacy cap', () => {
    const fitted = localExtractionWindowChars(4096)

    expect(fitted).toBeGreaterThan(1000)
    expect(fitted).toBeLessThan(24_000)

    const windows = splitIntoWindows(
      Array.from({ length: 90 }, (_, i) => `THEM: Synthetic implementation update ${i}.`).join('\n'),
      fitted,
      Math.min(1000, Math.floor(fitted / 8))
    )

    expect(windows.length).toBeGreaterThan(1)
    expect(windows.every((window) => window.length <= fitted)).toBe(true)
  })

  it('keeps the full legacy window when a roomy slot can hold it', () => {
    expect(localExtractionWindowChars(24_576)).toBe(24_000)
  })

  it('keeps the restored fitWindowChars identifier on the ingest boundary', () => {
    expect(fitWindowChars(4096, buildExtractionSystem(EXTRACTION_REMINDER).length, 24_000)).toBe(localExtractionWindowChars(4096))
  })
})
