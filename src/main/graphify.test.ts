import { describe, it, expect, vi } from 'vitest'

vi.mock('electron')

import { computeRelated } from './graphify'

// Graph shaped like real graphify output: each concept node is owned by ONE note (its source_file),
// and the other note links to the same concept node cross-file. This is how shared people/topics
// connect notes that never reference each other directly.
const graph = {
  nodes: [
    { id: 'bnp_note', label: 'BNP Paribas RFP', file_type: 'document', source_file: '/notes/2026-06-01_bnp.md' },
    { id: 'owens_note', label: 'Owens-Corning extension', file_type: 'document', source_file: '/notes/2026-06-02_owens.md' },
    { id: 'tony', label: 'Tony Walteur', file_type: 'concept', source_file: '/notes/2026-06-01_bnp.md' },
    { id: 'cyber', label: 'Mantu cybersecurity team', file_type: 'concept', source_file: '/notes/2026-06-02_owens.md' },
    { id: 'lonely', label: 'Unrelated topic', file_type: 'concept', source_file: '/notes/2026-06-09_other.md' }
  ],
  links: [
    { source: 'bnp_note', target: 'tony', relation: 'references' },
    { source: 'owens_note', target: 'tony', relation: 'references' },
    { source: 'bnp_note', target: 'cyber', relation: 'shares_data_with' },
    { source: 'owens_note', target: 'cyber', relation: 'references' }
  ]
}

describe('computeRelated', () => {
  it('connects two notes through a shared person (1-hop, my concept) and team (2-hop, neighbour concept)', () => {
    const r = computeRelated(graph, '/notes/2026-06-01_bnp.md')
    expect(r.ok).toBe(true)
    // BNP owns "Tony"; it links to "cyber" (owned by Owens) → both are topics of this note.
    expect(r.topics).toEqual(expect.arrayContaining(['Tony Walteur', 'Mantu cybersecurity team']))
    // Owens connects to BNP via both shared concepts.
    const owens = r.notes.find((n) => n.title === 'Owens-Corning extension')
    expect(owens).toBeTruthy()
    expect(owens!.via.length).toBeGreaterThan(0)
    expect(owens!.file).toBe('2026-06-02_owens.md')
  })

  it('is symmetric — querying the other note finds the first', () => {
    const r = computeRelated(graph, '/notes/2026-06-02_owens.md')
    expect(r.notes.map((n) => n.title)).toContain('BNP Paribas RFP')
  })

  it('returns empty (not error) for a note absent from the graph', () => {
    const r = computeRelated(graph, '/notes/nonexistent.md')
    expect(r.ok).toBe(true)
    expect(r.notes).toEqual([])
    expect(r.topics).toEqual([])
  })
})
