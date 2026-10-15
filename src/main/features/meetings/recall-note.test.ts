import { describe, expect, it } from 'vitest'
import { readSavedNote } from './recall-note'

const note = (body: string): string =>
  `---\ntype: note\nmode: "general"\ntitle: "Synthetic note"\n---\n\n# Synthetic note\n\n${body}`

describe('readSavedNote', () => {
  it('returns the saved title, mode, question and answer with authored newlines intact', () => {
    const text = note(
      ['## Question', '', 'First line.', 'Second line.', '', '## Answer', '', 'Answer.', 'Follow-up.', ''].join('\n')
    )
    const result = readSavedNote(text, 'fallback.md')

    expect(result).toEqual({
      ok: true,
      kind: 'note',
      title: 'Synthetic note',
      mode: 'general',
      question: 'First line.\nSecond line.',
      answer: 'Answer.\nFollow-up.'
    })
  })

  it('fails closed on repeated structural answer headings', () => {
    const text = note(
      ['## Question', '', 'Question.', '', '## Answer', '', 'Answer.', '', '## Answer', '', 'Other.'].join('\n')
    )
    const result = readSavedNote(text, 'ambiguous.md')

    expect(result).toEqual({
      ok: false,
      error: 'This saved note could not be read.'
    })
  })

  it('returns undefined for non-note meeting documents', () => {
    const text = '---\ntype: meeting-transcript\n---\n\n## Full transcript\n'
    expect(readSavedNote(text, 'meeting.md')).toBeUndefined()
  })
})
