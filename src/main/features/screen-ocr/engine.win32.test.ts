import { describe, expect, it, vi } from 'vitest'
import { createScreenOcr } from './engine'

describe('screen OCR engine selection', () => {
  it('win32: read is undefined and extract is never called', () => {
    const extract = vi.fn(async () => 'text')
    const ocr = createScreenOcr({ platform: 'win32', helperPresent: () => true, extract })
    expect(ocr.read).toBeUndefined()
    expect(extract).not.toHaveBeenCalled()
  })

  it('win32: availability is unavailable/platform-unsupported', () => {
    const ocr = createScreenOcr({ platform: 'win32', helperPresent: () => true, extract: async () => null })
    expect(ocr.availability()).toEqual({ state: 'unavailable', reason: 'platform-unsupported' })
  })

  it('darwin: read is the injected extract (same reference)', () => {
    const extract = async (): Promise<string | null> => null
    const ocr = createScreenOcr({ platform: 'darwin', helperPresent: () => true, extract })
    expect(ocr.read).toBe(extract)
  })

  it('darwin: availability follows helperPresent on each call', () => {
    let present = true
    const ocr = createScreenOcr({ platform: 'darwin', helperPresent: () => present, extract: async () => null })
    expect(ocr.availability()).toEqual({ state: 'available', engine: 'vision' })
    present = false
    expect(ocr.availability()).toEqual({ state: 'unavailable', reason: 'helper-missing' })
  })

  describe.runIf(process.platform === 'win32')('on a real Windows host', () => {
    it('createScreenOcr({platform: process.platform}) reports unavailable', () => {
      const ocr = createScreenOcr({ platform: process.platform, helperPresent: () => false, extract: async () => null })
      expect(ocr.availability().state).toBe('unavailable')
      expect(ocr.read).toBeUndefined()
    })
  })
})
