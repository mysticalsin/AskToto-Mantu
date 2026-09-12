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

  it('preserves distinct named owners in live and saved-meeting recap input (MQA-307)', () => {
    const lines: TranscriptLine[] = [
      { ...line('them', 'I will send the report tomorrow.'), name: 'Alice' },
      { ...line('them', 'I will review it Friday.'), name: 'Bob' },
      { ...line('you', 'I will confirm the next meeting.'), name: 'Cahê' }
    ]
    expect(transcriptToText(lines)).toBe(
      'THEM (Alice): I will send the report tomorrow.\n' +
        'THEM (Bob): I will review it Friday.\n' +
        'YOU (Cahê): I will confirm the next meeting.'
    )
  })

  it('keeps imported names and unnamed voice clusters without inventing the operator', () => {
    const lines: TranscriptLine[] = [
      { speaker: 'unknown', name: 'Alice', text: 'The report is mine.', t: 0 },
      { speaker: 'unknown', name: 'Speaker 2', text: 'I can help.', t: 1 },
      { speaker: 'unknown', name: '  ', text: 'Another voice.', t: 2 }
    ]
    expect(transcriptToText(lines)).toBe(
      'Alice: The report is mine.\nSpeaker 2: I can help.\nSPEAKER: Another voice.'
    )
  })

  it('keeps speaker labels on one line and retains language boundaries and provisional filtering', () => {
    const lines: TranscriptLine[] = [
      { ...line('them', 'Vamos começar.'), name: '  Ana\r\n Silva\u0000 ', lang: 'Portuguese' },
      { ...line('them', 'Unfinished draft.'), name: 'Draft name', lang: 'French', provisional: true },
      { ...line('them', 'The report is ready.'), name: 'Ana Silva', lang: 'English' }
    ]
    expect(transcriptToText(lines)).toBe(
      'THEM (Ana Silva): Vamos começar.\n' +
        '[conversation switches to English]\n' +
        'THEM (Ana Silva): The report is ready.'
    )
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

  it('excludes provisional lines — a UI-only "…" placeholder must never reach the recap prompt (1B.2b)', () => {
    const lines: TranscriptLine[] = [
      line('you', 'How is the roadmap looking?'),
      { speaker: 'them', text: '…', t: 1, provisional: true }
    ]
    expect(transcriptToText(lines)).toBe('YOU: How is the roadmap looking?')
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
  const target = {
    file: 'meeting.md',
    ownerId: 'meeting-1',
    runId: 'run-1',
    priorText: 'Earlier partial notes.'
  }

  const answer = (
    partial: Partial<{ id: string; text: string; streaming: boolean; error: string | null; completion: 'pending' | 'complete' | 'incomplete' }>
  ) => ({
    id: 'run-1',
    text: 'Notes here.',
    streaming: false,
    error: null,
    completion: 'complete' as const,
    ...partial
  })

  it('marks only an explicitly completed non-empty answer complete', () => {
    expect(recapPersistAction(answer({}), target, 'meeting-1')).toEqual({
      file: 'meeting.md',
      ownerId: 'meeting-1',
      runId: 'run-1',
      text: 'Notes here.',
      recapStatus: 'complete'
    })
  })

  it('retains even a short incomplete partial with an explicit incomplete status', () => {
    expect(
      recapPersistAction(
        answer({ text: 'Short partial', error: 'safe terminal error', completion: 'incomplete' }),
        target,
        'meeting-1'
      )
    ).toMatchObject({ text: 'Short partial', recapStatus: 'incomplete' })
  })

  it('fails closed to incomplete when a structurally conflicting terminal answer also has an error', () => {
    expect(
      recapPersistAction(
        answer({ text: 'Useful partial', error: 'terminal transport error', completion: 'complete' }),
        target,
        'meeting-1'
      )
    ).toMatchObject({ text: 'Useful partial', recapStatus: 'incomplete' })
  })

  it('uses only the exact target prior text when an incomplete retry returns empty', () => {
    expect(
      recapPersistAction(
        answer({ text: '', error: 'safe terminal error', completion: 'incomplete' }),
        target,
        'meeting-1'
      )
    ).toMatchObject({ text: 'Earlier partial notes.', recapStatus: 'incomplete' })
  })

  it('stores an empty first failed attempt as incomplete without borrowing other text', () => {
    expect(
      recapPersistAction(
        answer({ text: '', error: 'safe terminal error', completion: 'incomplete' }),
        { ...target, priorText: '' },
        'meeting-1'
      )
    ).toMatchObject({ text: '', recapStatus: 'incomplete' })
  })

  it('treats a hollow terminal completion as incomplete and preserves the exact target baseline', () => {
    expect(recapPersistAction(answer({ text: '' }), target, 'meeting-1')).toMatchObject({
      text: 'Earlier partial notes.',
      recapStatus: 'incomplete'
    })
  })

  it('does not persist pending output even when carried text is visible', () => {
    expect(
      recapPersistAction(answer({ text: 'Old answer still visible', streaming: true, completion: 'pending' }), target, 'meeting-1')
    ).toBeNull()
  })

  it('rejects stale answer runs and stale meeting owners', () => {
    expect(recapPersistAction(answer({ id: 'old-run' }), target, 'meeting-1')).toBeNull()
    expect(recapPersistAction(answer({}), target, 'meeting-2')).toBeNull()
  })

  it('returns null without an answer or target', () => {
    expect(recapPersistAction(null, target, 'meeting-1')).toBeNull()
    expect(recapPersistAction(answer({}), null, 'meeting-1')).toBeNull()
  })
})
