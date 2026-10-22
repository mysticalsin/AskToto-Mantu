import { describe, expect, it } from 'vitest'
import { parseMetisCommandTranscript } from './metis-command-parse'

// The panel parser is a view over the V03 voice grammar (src/shared/voice/voice-grammar.ts), which has the
// full multilingual tables. These pin the snapshot shape the session reducer depends on.
describe('deterministic command parser', () => {
  it('returns typed candidates without execution authority', () => {
    const early = parseMetisCommandTranscript('Métis open')
    expect(early.candidates).toHaveLength(0)

    const done = parseMetisCommandTranscript('Métis open notes')
    expect(done.candidates.map((candidate) => candidate.request.id)).toEqual(['desktop.open_notes'])
    expect(done.candidates[0]?.confidence).toBe('deterministic')
  })

  it('yields at most one candidate: one utterance is one action, never a guessed sequence', () => {
    const snap = parseMetisCommandTranscript('Métis open notes create a new note titled hello open Arc')
    expect(snap.candidates).toHaveLength(0)
  })

  it('carries real, bounded slots instead of the old fixed demo arguments', () => {
    expect(parseMetisCommandTranscript('create a new note titled Groceries').candidates[0]?.request).toEqual({
      id: 'desktop.create_note',
      args: { title: 'Groceries' }
    })
    expect(parseMetisCommandTranscript('google cybernetics').candidates[0]?.request).toEqual({
      id: 'desktop.google_search',
      args: { q: 'cybernetics' }
    })
  })

  it('understands French, Portuguese and Spanish', () => {
    expect(parseMetisCommandTranscript('ouvre notes').candidates[0]?.request.id).toBe('desktop.open_notes')
    expect(parseMetisCommandTranscript('abre o aplicativo de notas').candidates[0]?.request.id).toBe(
      'desktop.open_notes'
    )
    expect(parseMetisCommandTranscript('busca cibernética').candidates[0]?.request.id).toBe('desktop.google_search')
  })

  it('returns no candidates for a negated utterance', () => {
    const snap = parseMetisCommandTranscript('Metis open notes actually do not')
    expect(snap.negation).toBe(true)
    expect(snap.candidates).toHaveLength(0)
  })

  it('hints at the intended action for an advisory-only provisional list', () => {
    expect(parseMetisCommandTranscript('create note').provisional).toEqual(['desktop.create_note'])
    expect(parseMetisCommandTranscript('search').provisional).toEqual(['desktop.google_search'])
    expect(parseMetisCommandTranscript('open spotify').provisional).toEqual([])
  })

  it('an incomplete request is ambiguous, not a candidate', () => {
    const snap = parseMetisCommandTranscript('create a note')
    expect(snap.ambiguous).toBe(true)
    expect(snap.candidates).toHaveLength(0)
  })
})
