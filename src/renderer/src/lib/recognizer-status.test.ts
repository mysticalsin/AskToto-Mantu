import { describe, expect, it } from 'vitest'
import { recognizerStatusFor } from './listen'

describe('recognizer status truthfulness', () => {
  it('reports the compact packaged Whisper base model rather than an unavailable large model', () => {
    expect(recognizerStatusFor('whisper', 'wasm', 'auto', null)).toEqual({
      engine: 'whisper',
      model: 'whisper-base',
      languageMode: 'detecting',
      language: null,
      requestedLanguage: null
    })
  })

  it('distinguishes the requested language from effective engine behavior and a confirmed pin', () => {
    // Parakeet currently detects language itself. A configured French preference must not be presented as
    // an engine-enforced explicit language.
    expect(recognizerStatusFor('parakeet', null, 'French', null)).toMatchObject({
      languageMode: 'engine-auto',
      language: null,
      requestedLanguage: 'French'
    })
    expect(recognizerStatusFor('whisper', 'webgpu', 'auto', 'Portuguese')).toMatchObject({
      model: 'whisper-large-v3-turbo',
      languageMode: 'pinned',
      language: 'Portuguese'
    })
  })
})
