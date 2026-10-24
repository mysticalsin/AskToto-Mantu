/**
 * ocr-availability.ts — the typed, honest answer to "can this install read screen text on-device?" (G89).
 *
 * macOS reads text with the Vision framework through the bundled metis-mac-helper. Windows has no OCR engine
 * and Métis ships no fake one: the state is `unavailable`, with a reason the UI and diagnostics can show.
 * Pure function of the platform and whether the helper binary is present; carries no content.
 */
export type OcrUnavailableReason = 'platform-unsupported' | 'helper-missing'

export type OcrAvailability =
  | { state: 'available'; engine: 'vision' }
  | { state: 'unavailable'; reason: OcrUnavailableReason }

export function resolveOcrAvailability(platform: NodeJS.Platform, helperPresent: boolean): OcrAvailability {
  if (platform !== 'darwin') return { state: 'unavailable', reason: 'platform-unsupported' }
  return helperPresent ? { state: 'available', engine: 'vision' } : { state: 'unavailable', reason: 'helper-missing' }
}

export function ocrUnavailableCopy(reason: OcrUnavailableReason): string {
  return reason === 'platform-unsupported'
    ? "On-device text reading (OCR) isn't available on Windows."
    : "On-device text reading (OCR) isn't installed in this copy of Métis."
}
