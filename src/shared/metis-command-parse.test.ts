import { describe, expect, it } from 'vitest'
import { parseMetisCommandTranscript } from './metis-command-parse'

describe('Cap2 deterministic mid-sentence parse', () => {
  it('commits open notes as keywords finalize', () => {
    const early = parseMetisCommandTranscript('Métis open')
    expect(early.commits).toHaveLength(0)

    const done = parseMetisCommandTranscript('Métis open notes')
    expect(done.commits.map((c) => c.request.id)).toEqual(['desktop.open_notes'])
  })

  it('creates note titled hello exactly', () => {
    const snap = parseMetisCommandTranscript(
      'Métis create a new note titled hello'
    )
    expect(snap.commits[0]?.request).toEqual({
      id: 'desktop.create_note',
      args: { title: 'hello' }
    })
  })

  it('runs the video chain from one utterance in order', () => {
    const text =
      'Métis open notes create a note titled hello open Arc google Norbert Wiener open x.com open Photo Booth and take a picture'
    const snap = parseMetisCommandTranscript(text)
    expect(snap.commits.map((c) => c.request.id)).toEqual([
      'desktop.open_notes',
      'desktop.create_note',
      'desktop.open_arc',
      'desktop.google_search',
      'desktop.open_x',
      'desktop.photo_booth_capture'
    ])
    expect(snap.commits.find((c) => c.request.id === 'desktop.google_search')?.request).toEqual({
      id: 'desktop.google_search',
      args: { q: 'Norbert Wiener' }
    })
  })

  it('interim negation cancels uncommitted steps', () => {
    const snap = parseMetisCommandTranscript('Metis open notes actually do not')
    expect(snap.negation).toBe(true)
    expect(snap.commits).toHaveLength(0)
  })

  it('skips already committed fingerprints', () => {
    const committed = new Set(['desktop.open_notes'])
    const snap = parseMetisCommandTranscript('Métis open notes open Arc', committed)
    expect(snap.commits.map((c) => c.request.id)).toEqual(['desktop.open_arc'])
  })

  it('does not require Jev for deterministic path', () => {
    const snap = parseMetisCommandTranscript('Métis open Arc')
    expect(snap.commits[0]?.confidence).toBe('deterministic')
  })
})
