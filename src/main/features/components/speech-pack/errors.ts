export type SpeechPackErrorKind = 'offline' | 'disk' | 'tamper' | 'captive' | 'http' | 'cancelled'

/** A terminal failure. Carries a kind and byte counts only — never a path, URL body or user content. */
export class SpeechPackError extends Error {
  constructor(
    readonly kind: SpeechPackErrorKind,
    message: string,
    readonly requiredBytes?: number,
    readonly freeBytes?: number
  ) {
    super(message)
    this.name = 'SpeechPackError'
  }
}
