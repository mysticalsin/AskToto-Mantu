import { describe, expect, it } from 'vitest'
import {
  applyConfirmedSpeakerNames,
  isOverlapSpeakerLabel,
  isSessionSpeakerLabel,
  isUnknownSpeakerLabel,
  OVERLAP_SPEAKER_LABEL,
  remapTranscriptSpeakerNames,
  sessionSpeakerLabels,
  transcriptDisplayName,
  unknownSpeakerLabel
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

describe('transcriptDisplayName / unknown / overlap', () => {
  it('keeps confirmed names primary', () => {
    expect(transcriptDisplayName({ speaker: 'them', name: 'Ada Lovelace' })).toBe('Ada Lovelace')
  })
  it('keeps Speaker N and Unknown honest', () => {
    expect(transcriptDisplayName({ speaker: 'unknown', name: 'Speaker 2' })).toBe('Speaker 2')
    expect(transcriptDisplayName({ speaker: 'unknown' })).toBe('Unknown speaker 1')
    expect(isUnknownSpeakerLabel(unknownSpeakerLabel(3))).toBe(true)
  })
  it('marks overlap explicitly', () => {
    expect(transcriptDisplayName({ speaker: 'them', overlap: true })).toBe(OVERLAP_SPEAKER_LABEL)
    expect(isOverlapSpeakerLabel(OVERLAP_SPEAKER_LABEL)).toBe(true)
  })
})

describe('applyConfirmedSpeakerNames', () => {
  it('maps clusters to people and leaves unmapped as Unknown speaker N', () => {
    const lines = [
      { speaker: 'them' as const, name: 'Speaker 1', text: 'a', t: 1 },
      { speaker: 'them' as const, name: 'Speaker 2', text: 'b', t: 2 },
      { speaker: 'them' as const, name: 'Speaker 1', text: 'c', t: 3 },
      { speaker: 'them' as const, overlap: true, text: 'd', t: 4 }
    ]
    const out = applyConfirmedSpeakerNames(lines, { 'Speaker 1': 'Ada' })
    expect(out.map((l) => l.name)).toEqual(['Ada', 'Unknown speaker 1', 'Ada', OVERLAP_SPEAKER_LABEL])
  })
})
