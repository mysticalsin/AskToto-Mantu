import { describe, expect, it } from 'vitest'
import { readModuleSource } from '../test-helpers/module-source'

const index = readModuleSource(__dirname, './index').text

describe('screen OCR wiring in index', () => {
  it('passes screenOcr.read to screen preprocess and to context-grants readText', () => {
    expect(index).toContain('extractScreenText: screenOcr.read')
    expect(index).toContain('readText: screenOcr.read')
  })

  it("no longer gates the reader with process.platform === 'darwin' ? extractScreenText", () => {
    expect(index).not.toMatch(/process\.platform === 'darwin' \? extractScreenText/)
  })

  it('builds the diagnostics identity from the OCR host seam, which includes screenOcr.availability()', () => {
    expect(index).toContain('identity: diagnosticsIdentity()')
    expect(readModuleSource(__dirname, './features/screen-ocr/host').text).toContain('ocr: screenOcr.availability()')
  })
})
