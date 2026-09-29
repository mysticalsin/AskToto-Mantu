import { describe, expect, it } from 'vitest'
import { speechPackEnabled } from './flag'

describe('speech-pack flag', () => {
  it('is off by default', () => {
    expect(speechPackEnabled({}, [])).toBe(false)
  })
  it('reads METIS_SPEECH_PACK', () => {
    expect(speechPackEnabled({ METIS_SPEECH_PACK: 'on' }, [])).toBe(true)
    expect(speechPackEnabled({ METIS_SPEECH_PACK: 'off' }, [])).toBe(false)
    expect(speechPackEnabled({ METIS_SPEECH_PACK: 'yes' }, [])).toBe(false)
  })
  it('the command line wins over the environment', () => {
    expect(speechPackEnabled({ METIS_SPEECH_PACK: 'off' }, ['--speech-pack=on'])).toBe(true)
    expect(speechPackEnabled({ METIS_SPEECH_PACK: 'on' }, ['--speech-pack=off'])).toBe(false)
  })
})
