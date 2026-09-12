import { describe, expect, it } from 'vitest'
import type { TranscriptLine } from './ipc'
import { reviewSpeakerLabel } from './speaker-summary'

const line = (speaker: TranscriptLine['speaker'], name?: string): TranscriptLine => ({
  speaker, name, text: 'Synthetic speech.', t: 0
})

describe('MQA-312 truthful Review speaker labels', () => {
  it('counts Alice and Bob separately on the same remote audio channel', () => {
    expect(reviewSpeakerLabel([line('them', 'Alice'), line('them', 'Bob'), line('them', 'Alice')])).toBe('2 speakers')
  })

  it('counts distinct diarization clusters in mixed imported audio', () => {
    expect(reviewSpeakerLabel([line('unknown', 'Speaker 1'), line('unknown', 'Speaker 2')])).toBe('2 speakers')
  })

  it('normalizes display-name whitespace, case and Unicode without duplicating identities across channels', () => {
    expect(reviewSpeakerLabel([
      line('unknown', '  Cahê  Silva '), line('them', 'CAHE\u0302\tSILVA'), line('you', 'Cahê Silva')
    ])).toBe('1 speaker')
  })

  it('does not invent an identified headcount for unnamed mixed imports', () => {
    expect(reviewSpeakerLabel([line('unknown'), line('unknown'), line('unknown', '   ')])).toBe('Speakers not yet identified')
  })

  it('keeps an unnamed You separate from identified remote speakers', () => {
    expect(reviewSpeakerLabel([line('you'), line('them', 'Alice'), line('them', 'Bob')])).toBe('3 speakers')
  })

  it('does not add unnamed mic lines as another person when You already has a name', () => {
    expect(reviewSpeakerLabel([line('you', 'Tony'), line('you'), line('them', 'Alice')])).toBe('2 speakers')
  })

  it('does not count unnamed remote fragments as another person on an already-named channel', () => {
    expect(reviewSpeakerLabel([line('them', 'Alice'), line('them', 'Bob'), line('them')])).toBe('At least 2 speakers')
  })

  it('does not count unnamed imported fragments as another person alongside known clusters', () => {
    expect(reviewSpeakerLabel([line('unknown', 'Speaker 1'), line('unknown')])).toBe('At least 1 speaker')
  })

  it('describes unnamed mic plus remote channels as a lower bound, not two identified participants', () => {
    expect(reviewSpeakerLabel([line('you'), line('them'), line('them')])).toBe('At least 2 speakers')
    expect(reviewSpeakerLabel([line('them')])).toBe('At least 1 speaker')
  })

  it('does not add an unknown mixed channel to identified mic and remote names', () => {
    expect(reviewSpeakerLabel([line('you', 'Tony'), line('them', 'Alice'), line('unknown')])).toBe('At least 2 speakers')
  })

  it('keeps mixed named-import and unnamed-channel evidence conservative', () => {
    expect(reviewSpeakerLabel([line('unknown', 'Alice'), line('them')])).toBe('At least 1 speaker')
    expect(reviewSpeakerLabel([line('unknown', 'Alice'), line('you')])).toBe('At least 1 speaker')
    expect(reviewSpeakerLabel([line('unknown', 'Alice'), line('you'), line('them')])).toBe('At least 2 speakers')
  })

  it('reports one speaker for only the established mic channel', () => {
    expect(reviewSpeakerLabel([line('you'), line('you')])).toBe('1 speaker')
  })

  it('ignores empty and provisional transcript placeholders', () => {
    expect(reviewSpeakerLabel([
      { ...line('them', 'Alice'), provisional: true }, { ...line('you'), text: '   ' }
    ])).toBe('Speakers not yet identified')
    expect(reviewSpeakerLabel([])).toBe('Speakers not yet identified')
  })
})
