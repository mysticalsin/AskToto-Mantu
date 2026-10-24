import { describe, expect, it } from 'vitest'
import { readModuleSource } from '../../../../test-helpers/module-source'

const source = readModuleSource(__dirname, './AudioTab').text

describe('AudioTab OCR availability copy', () => {
  it('imports ocrUnavailableCopy from @shared/ocr-availability', () => {
    expect(source).toMatch(/import \{[^}]*ocrUnavailableCopy[^}]*\} from '@shared\/ocr-availability'/)
  })

  it("uses ocrUnavailableCopy('platform-unsupported') in the Windows fallback branch", () => {
    expect(source).toContain("ocrUnavailableCopy('platform-unsupported')")
  })
})
