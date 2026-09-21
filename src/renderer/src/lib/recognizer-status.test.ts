import { describe, expect, it } from 'vitest'
import { recognizerStatusFor } from './listen'

describe('recognizer status truthfulness', () => {
  it('reports the compact packaged Whisper base model rather than an unavailable large model', () => {
    expect(recognizerStatusFor('whisper', 'wasm', 'auto', null)).toEqual({
      engine: 'whisper',
      model: 'whisper-base',
      languageMode: 'detecting',
      language: null
    })
  })

  it('distinguishes explicit language from auto detection and a confirmed pin', () => {
    expect(recognizerStatusFor('parakeet', null, 'French', null)).toMatchObject({ languageMode: 'explicit', language: 'French' })
    expect(recognizerStatusFor('whisper', 'webgpu', 'auto', 'Portuguese')).toMatchObject({
      model: 'whisper-large-v3-turbo',
      languageMode: 'pinned',
      language: 'Portuguese'
    })
  })
})
