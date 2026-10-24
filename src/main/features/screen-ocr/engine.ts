import { resolveOcrAvailability, type OcrAvailability } from '../../../shared/ocr-availability'

export interface ScreenOcr {
  availability(): OcrAvailability
  /** Undefined when this platform has no OCR engine; consumers treat that as "no OCR", never as empty text. */
  read: ((imageB64: string) => Promise<string | null>) | undefined
}

/**
 * Selects the OCR reader for the platform. It only selects the existing mac-helper spawn (`extract`); it
 * never wraps or replaces it. `read` is fixed at construction; `availability()` re-reads the helper each call.
 */
export function createScreenOcr(deps: {
  platform: NodeJS.Platform
  helperPresent: () => boolean
  extract: (imageB64: string) => Promise<string | null>
}): ScreenOcr {
  return {
    availability: () => resolveOcrAvailability(deps.platform, deps.helperPresent()),
    read: deps.platform === 'darwin' ? deps.extract : undefined
  }
}
