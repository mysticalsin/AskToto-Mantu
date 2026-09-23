import { describe, expect, it } from 'vitest'
import { parseMetisCommandTranscript } from './metis-command-parse'

describe('deterministic command parser', () => {
  it('returns typed candidates without execution authority', () => {
    const early = parseMetisCommandTranscript('Métis open')
    expect(early.candidates).toHaveLength(0)

    const done = parseMetisCommandTranscript('Métis open notes')
    expect(done.candidates.map((candidate) => candidate.request.id)).toEqual(['desktop.open_notes'])
    expect(done.candidates[0]?.confidence).toBe('deterministic')
  })

  it('returns every matched candidate in deterministic static order', () => {
    const snap = parseMetisCommandTranscript(
      'Métis open notes create a new note titled hello open Arc'
    )
    expect(snap.candidates.map((candidate) => candidate.request.id)).toEqual([
      'desktop.open_notes',
      'desktop.create_note',
      'desktop.open_arc'
    ])
    expect(snap.candidates[1]?.request).toEqual({
      id: 'desktop.create_note',
      args: { title: 'hello' }
    })
  })

  it('returns no candidates for a negated utterance', () => {
    const snap = parseMetisCommandTranscript('Metis open notes actually do not')
    expect(snap.negation).toBe(true)
    expect(snap.candidates).toHaveLength(0)
  })
})
