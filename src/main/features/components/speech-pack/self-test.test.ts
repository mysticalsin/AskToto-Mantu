import { describe, expect, it } from 'vitest'
import { PARAKEET_TDT_V3_INT8, WHISPER_BASE_Q8 } from './manifest'
import { speechPackHostEntryPath } from './self-test'

describe('speech-pack utility host bundle paths', () => {
  it('resolves existing host entry points beside the main bundle output', () => {
    expect(speechPackHostEntryPath('/app/out/main', WHISPER_BASE_Q8.id)).toBe('/app/out/main/whisper-asr-host.js')
    expect(speechPackHostEntryPath('/app/out/main', PARAKEET_TDT_V3_INT8.id)).toBe('/app/out/main/parakeet-asr-host.js')
  })
})
