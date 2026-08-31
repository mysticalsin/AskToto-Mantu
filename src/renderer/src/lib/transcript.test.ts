import { describe, it, expect } from 'vitest'
import { transcriptToText, recapPersistAction } from './transcript'
import type { TranscriptLine } from '@shared/ipc'

function line(speaker: 'them' | 'you', text: string, t = 0): TranscriptLine {
  return { speaker, text, t }
}

describe('transcriptToText', () => {
  it('joins mixed them/you lines as "THEM: "/"YOU: " prefixed lines, one per line', () => {
    const lines: TranscriptLine[] = [
      line('them', 'Hi, how are you?'),
      line('you', "I'm good, thanks."),
      line('them', "Let's get started.")
    ]
    expect(transcriptToText(lines)).toBe(
      'THEM: Hi, how are you?\nYOU: I\'m good, thanks.\nTHEM: Let\'s get started.'
    )
  })

  it('renders an empty-text line as a prefix with nothing after the colon', () => {
    const lines: TranscriptLine[] = [line('you', '')]
    expect(transcriptToText(lines)).toBe('YOU: ')
  })

  it('returns an empty string for an empty array', () => {
    expect(transcriptToText([])).toBe('')
  })

  it('uses a neutral label for imported recordings whose speakers are not diarized', () => {
    const lines = [{ speaker: 'unknown', text: 'Question from the recording.', t: 0 }] as TranscriptLine[]
    expect(transcriptToText(lines)).toBe('SPEAKER: Question from the recording.')
  })

  it('emits a "[conversation switches to …]" marker where the tagged language changes', () => {
    const lines: TranscriptLine[] = [
      { speaker: 'them', text: 'Então vamos ver o contrato.', t: 0, lang: 'Portuguese' },
      { speaker: 'you', text: 'Sim, perfeito.', t: 1, lang: 'Portuguese' },
      { speaker: 'them', text: 'So, about the budget for next year.', t: 2, lang: 'English' },
      { speaker: 'you', text: 'Yes, we can cover that now.', t: 3, lang: 'English' }
    ]
    expect(transcriptToText(lines)).toBe(
      'THEM: Então vamos ver o contrato.\n' +
        'YOU: Sim, perfeito.\n' +
        '[conversation switches to English]\n' +
        'THEM: So, about the budget for next year.\n' +
        'YOU: Yes, we can cover that now.'
    )
  })

  it('never emits markers for untagged lines (older meetings, unconfident detection) or before the first tag', () => {
    const lines: TranscriptLine[] = [
      { speaker: 'them', text: 'Hmm.', t: 0 }, // untagged
      { speaker: 'you', text: 'Então vamos ver isso.', t: 1, lang: 'Portuguese' }, // first tag — no marker
      { speaker: 'them', text: 'Ok.', t: 2 }, // untagged gap — carries no language change
      { speaker: 'you', text: 'Vamos fechar assim.', t: 3, lang: 'Portuguese' } // same language — no marker
    ]
    expect(transcriptToText(lines)).toBe(
      'THEM: Hmm.\nYOU: Então vamos ver isso.\nTHEM: Ok.\nYOU: Vamos fechar assim.'
    )
  })

  it('drops streaming provisional lines so recap/save never see a first-caption draft', () => {
    const lines: TranscriptLine[] = [
      { speaker: 'them', text: 'Then we close.', t: 1 },
      { speaker: 'you', text: '…', t: 2, provisional: true }
    ]
    expect(transcriptToText(lines)).toBe('THEM: Then we close.')
  })
})

describe('recapPersistAction', () => {
  const target = { file: 'meeting.md' }

  it('returns {file, text} once the answer settles with real text and no error', () => {
    const answer = { text: 'Notes here.', streaming: false, error: null }
    expect(recapPersistAction(answer, target)).toEqual({ file: 'meeting.md', text: 'Notes here.' })
  })

  it('returns null while the answer is still streaming, even with text already buffered', () => {
    const answer = { text: 'partial notes', streaming: true, error: null }
    expect(recapPersistAction(answer, target)).toBeNull()
  })

  it('returns null when the answer settled with an error (recap stays empty)', () => {
    const answer = { text: '', streaming: false, error: 'No provider configured.' }
    expect(recapPersistAction(answer, target)).toBeNull()
  })

  it('returns null when the answer settled with an error even if some text is present', () => {
    const answer = { text: 'partial', streaming: false, error: 'boom' }
    expect(recapPersistAction(answer, target)).toBeNull()
  })

  it('returns null when there is no answer at all', () => {
    expect(recapPersistAction(null, target)).toBeNull()
  })

  it('returns null when there is no target, even with a settled successful answer', () => {
    const answer = { text: 'Notes here.', streaming: false, error: null }
    expect(recapPersistAction(answer, null)).toBeNull()
  })

  it('returns null when the answer settled successfully but with empty text', () => {
    const answer = { text: '', streaming: false, error: null }
    expect(recapPersistAction(answer, target)).toBeNull()
  })
})
