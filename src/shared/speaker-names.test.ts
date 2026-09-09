import { describe, expect, it } from 'vitest'
import {
  isSessionSpeakerLabel,
  remapTranscriptSpeakerNames,
  sessionSpeakerLabels
} from './speaker-names'

describe('isSessionSpeakerLabel', () => {
  it('accepts Speaker N forms', () => {
    expect(isSessionSpeakerLabel('Speaker 1')).toBe(true)
    expect(isSessionSpeakerLabel('Speaker 12')).toBe(true)
    expect(isSessionSpeakerLabel(' speaker 3 ')).toBe(true)
  })
  it('rejects enrolled or empty names', () => {
    expect(isSessionSpeakerLabel('Jane Doe')).toBe(false)
    expect(isSessionSpeakerLabel('Them')).toBe(false)
    expect(isSessionSpeakerLabel('')).toBe(false)
    expect(isSessionSpeakerLabel(null)).toBe(false)
  })
})

describe('remapTranscriptSpeakerNames', () => {
  it('rewrites matching names and leaves others alone', () => {
    const lines = [
      { speaker: 'them' as const, text: 'a', t: 1, name: 'Speaker 1' },
      { speaker: 'them' as const, text: 'b', t: 2, name: 'Speaker 2' },
      { speaker: 'you' as const, text: 'c', t: 3 },
      { speaker: 'them' as const, text: 'd', t: 4, name: 'Speaker 1' }
    ]
    const out = remapTranscriptSpeakerNames(lines, new Map([['Speaker 1', 'Ada'], ['Speaker 2', 'Speaker 1']]))
    expect(out.map((l) => l.name)).toEqual(['Ada', 'Speaker 1', undefined, 'Ada'])
  })
  it('returns the same array for an empty map', () => {
    const lines = [{ speaker: 'them' as const, text: 'a', t: 1, name: 'Speaker 1' }]
    expect(remapTranscriptSpeakerNames(lines, new Map())).toBe(lines)
  })
})

describe('sessionSpeakerLabels', () => {
  it('lists unique Speaker N labels in numeric order', () => {
    expect(
      sessionSpeakerLabels([
        { name: 'Speaker 2' },
        { name: 'Ada' },
        { name: 'Speaker 10' },
        { name: 'Speaker 2' },
        {}
      ])
    ).toEqual(['Speaker 2', 'Speaker 10'])
  })
})
