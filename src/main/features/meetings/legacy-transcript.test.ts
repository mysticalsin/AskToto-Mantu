import { describe, it, expect } from 'vitest'
import { formatTranscript } from './transcript-format'
import { readLegacyTranscript } from './legacy-transcript'

describe('MQA-245 — a diarization cluster label is not wrapped in the generic role label', () => {
  it('renders "Speaker 1:", never "Speaker (Speaker 1):"', () => {
    const t = Date.parse('2026-02-02T10:00:00Z')
    const body = formatTranscript([
      { t, speaker: 'unknown', text: 'first line', name: 'Speaker 1' },
      { t: t + 1000, speaker: 'unknown', text: 'second line', name: 'Speaker 2' }
    ])
    expect(body).not.toMatch(/Speaker \(Speaker \d+\)/)
    expect(body).toMatch(/\*\*\[\d{2}:\d{2}:\d{2}\] Speaker 1:\*\* first line/)
    expect(body).toMatch(/\*\*\[\d{2}:\d{2}:\d{2}\] Speaker 2:\*\* second line/)
  })

  it('still qualifies a REAL name with the role — "Them (Jane Doe)" says two things', () => {
    const t = Date.parse('2026-02-02T10:00:00Z')
    const body = formatTranscript([
      { t, speaker: 'them', text: 'hello', name: 'Jane Doe' },
      { t: t + 1000, speaker: 'you', text: 'hi', name: 'Jane Doe' },
      // A cluster label on a KNOWN role is not the collapsing case either.
      { t: t + 2000, speaker: 'them', text: 'ok', name: 'Speaker 3' }
    ])
    expect(body).toMatch(/Them \(Jane Doe\):/)
    expect(body).toMatch(/You \(Jane Doe\):/)
    expect(body).toMatch(/Them \(Speaker 3\):/)
  })

  it('the bare label survives the round trip through recall.ts — the line is not lost', () => {
    // The real risk of touching a durable format: a line the writer emits that the reader cannot match
    // disappears from recall entirely. Run the actual reader used by recall rather than a source regex
    // or a duplicated parser, so the durable speaker identity is checked through shipped behavior.

    const t = Date.parse('2026-02-02T10:00:00Z')
    const body = formatTranscript([
      { t, speaker: 'unknown', text: 'cluster line', name: 'Speaker 1' },
      { t: t + 1000, speaker: 'them', text: 'named line', name: 'Jane Doe' },
      { t: t + 2000, speaker: 'you', text: 'plain line' }
    ])
    const matched = readLegacyTranscript(`## Full transcript\n\n${body}`, t)
    expect(matched, 'a written line did not match the reader').toHaveLength(3)
    expect(matched[0]).toMatchObject({ speaker: 'unknown', name: 'Speaker 1', text: 'cluster line', t })
    expect(matched[1]).toMatchObject({ speaker: 'them', name: 'Jane Doe', text: 'named line', t: t + 1000 })
    expect(matched[2]).toMatchObject({ speaker: 'you', text: 'plain line', t: t + 2000 })
  })

  it('the legacy "Speaker (Speaker 1)" form still parses — old meetings do not change meaning', () => {
    const legacy = '**[10:00:00] Speaker (Speaker 1):** an older saved line'
    const hit = readLegacyTranscript(`## Full transcript\n\n${legacy}`, Date.parse('2026-02-02T10:00:00Z'))
    expect(hit).toHaveLength(1)
    expect(hit[0]).toMatchObject({ speaker: 'unknown', name: 'Speaker 1', text: 'an older saved line' })
  })
})

