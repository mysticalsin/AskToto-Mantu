export interface RecognizerStatus {
  engine: 'whisper' | 'parakeet' | 'apple' | 'cloud'
  model: 'whisper-base' | 'whisper-large-v3-turbo' | 'parakeet' | 'apple-speech' | 'cloud-stt' | null
  /** Effective engine behavior, which can differ from the user's requested language. */
  languageMode: 'explicit' | 'detecting' | 'pinned' | 'engine-auto'
  language: string | null
  requestedLanguage: string | null
}

export function recognizerStatusFor(
  engine: RecognizerStatus['engine'],
  workerEngine: 'wasm' | 'webgpu' | null,
  language: string,
  pinnedLanguage: string | null
): RecognizerStatus {
  const model =
    engine === 'whisper'
      ? workerEngine === 'webgpu'
        ? 'whisper-large-v3-turbo'
        : workerEngine === 'wasm'
          ? 'whisper-base'
          : null
      : engine === 'parakeet'
        ? 'parakeet'
        : engine === 'apple'
          ? 'apple-speech'
          : 'cloud-stt'
  const requestedLanguage = language === 'auto' ? null : language
  // Parakeet's live recognizer auto-detects regardless of the configured preference. Keep the preference
  // separately for supportability, but never present it as an engine-enforced language.
  if (engine === 'parakeet') return { engine, model, languageMode: 'engine-auto', language: null, requestedLanguage }
  return language !== 'auto'
    ? { engine, model, languageMode: 'explicit', language, requestedLanguage }
    : pinnedLanguage
      ? { engine, model, languageMode: 'pinned', language: pinnedLanguage, requestedLanguage: null }
      : { engine, model, languageMode: 'detecting', language: null, requestedLanguage: null }
}
