import { describe, expect, it } from 'vitest'
import { approveVoices, resolveVoiceChoice } from './approved-voices'

const voice = (id: string, name: string, language: string) => ({ id, name, language })

describe('approveVoices (G27, D-13: installed system voices only, never downloads)', () => {
  it('on macOS keeps the Apple speech voices and drops novelty, Eloquence and unknown-vendor voices', () => {
    const approved = approveVoices('darwin', [
      voice('com.apple.voice.compact.en-US.Samantha', 'Samantha', 'en-US'),
      voice('com.apple.voice.enhanced.fr-FR.Amelie', 'Amelie', 'fr-FR'),
      voice('com.apple.speech.synthesis.voice.BadNews', 'Bad News', 'en-US'),
      voice('com.apple.eloquence.en-US.Rocko', 'Rocko', 'en-US'),
      voice('com.example.voice.en', 'Synthetic', 'en-US')
    ])
    expect(approved.map((v) => v.name)).toEqual(['Samantha', 'Amelie'])
  })

  it('on Windows keeps the installed Microsoft voices only', () => {
    const approved = approveVoices('win32', [
      voice('Microsoft Zira Desktop', 'Microsoft Zira Desktop', 'en-US'),
      voice('Acme Robot', 'Acme Robot', 'en-US')
    ])
    expect(approved.map((v) => v.id)).toEqual(['Microsoft Zira Desktop'])
  })

  it('keeps English, French, Portuguese and Spanish voices and drops other languages', () => {
    const approved = approveVoices('darwin', [
      voice('com.apple.voice.compact.de-DE.Anna', 'Anna', 'de-DE'),
      voice('com.apple.voice.compact.pt-BR.Luciana', 'Luciana', 'pt-BR'),
      voice('com.apple.voice.compact.es-ES.Monica', 'Monica', 'es-ES'),
      voice('com.apple.voice.compact.en_GB.Daniel', 'Daniel', 'en_GB')
    ])
    expect(approved.map((v) => v.name).sort()).toEqual(['Daniel', 'Luciana', 'Monica'])
  })

  it('is empty on a platform with no engine, de-duplicates ids and is bounded', () => {
    expect(approveVoices('linux', [voice('com.apple.voice.compact.en-US.Samantha', 'Samantha', 'en-US')])).toEqual([])
    const dup = voice('com.apple.voice.compact.en-US.Samantha', 'Samantha', 'en-US')
    expect(approveVoices('darwin', [dup, dup])).toHaveLength(1)
    const many = Array.from({ length: 400 }, (_, i) => voice(`com.apple.voice.compact.en-US.V${i}`, `V${i}`, 'en-US'))
    expect(approveVoices('darwin', many).length).toBeLessThanOrEqual(100)
  })

  it('drops entries that are not well formed', () => {
    expect(
      approveVoices('darwin', [{ id: '', name: 'x', language: 'en-US' }, null as never, { id: 5 } as never])
    ).toEqual([])
  })
})

describe('resolveVoiceChoice', () => {
  const approved = [voice('v1', 'One', 'en-US'), voice('v2', 'Two', 'fr-FR')]
  it('returns an approved id as it is', () => expect(resolveVoiceChoice(approved, 'v2')).toBe('v2'))
  it('falls back only to an approved installed voice for null, unknown or removed ids', () => {
    expect(resolveVoiceChoice(approved, null)).toBe('v1')
    expect(resolveVoiceChoice(approved, 'com.apple.voice.premium.en-US.Zoe')).toBe('v1')
    expect(resolveVoiceChoice([], 'v1')).toBeNull()
    expect(resolveVoiceChoice(approved, undefined)).toBe('v1')
  })
})
