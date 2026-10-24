import { app } from 'electron'
import type { DiagnosticsIdentity } from '../../infra/observability/diagnostics-summary'
import { extractScreenText, macHelperPresent } from '../../mac-helper'
import { createScreenOcr } from './engine'

/** The process-wide OCR engine selection: macOS Vision via the mac helper, nothing on Windows. */
export const screenOcr = createScreenOcr({
  platform: process.platform,
  helperPresent: macHelperPresent,
  extract: extractScreenText
})

/** The content-free identity the diagnostics summary reports, including the OCR capability state. */
export function diagnosticsIdentity(): DiagnosticsIdentity {
  return {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    ocr: screenOcr.availability()
  }
}
