import { parse, readMeetingFields } from './meeting-document'

export type SavedNoteReadResult =
  | { ok: true; kind: 'note'; title: string; mode: string; question: string; answer: string }
  | { ok: false; error: string }

const NOTE_READ_ERROR = 'This saved note could not be read.'

/** Read one saved Q&A note without guessing when structural headings are ambiguous. */
export function readSavedNote(text: string, safeName: string): SavedNoteReadResult | undefined {
  const fields = readMeetingFields(text)
  if (fields.type !== 'note') return undefined

  const body = parse(text)?.body.replace(/^\r?\n/, '')
  // The current note writer has no escaping for structural section headings, so reject ambiguous copies
  // rather than misattribute question/answer text when it repeats one of these exact headings.
  const answerHeadings = body?.match(/^## Answer[ \t]*\r?$/gm) ?? []
  const questionHeadings = body?.match(/^## Question[ \t]*\r?$/gm) ?? []
  const answerSection = body?.match(/^## Answer[ \t]*\r?\n\r?\n([\s\S]*)$/m)
  if (!body || answerHeadings.length !== 1 || questionHeadings.length > 1 || !answerSection) {
    return { ok: false, error: NOTE_READ_ERROR }
  }

  const answerIndex = answerSection.index
  if (answerIndex === undefined) return { ok: false, error: NOTE_READ_ERROR }
  const questionSection = /^## Question[ \t]*\r?\n\r?\n/m.exec(body)
  if (questionSection && questionSection.index >= answerIndex) {
    return { ok: false, error: NOTE_READ_ERROR }
  }
  let question = ''
  if (questionSection && questionSection.index < answerIndex) {
    question = body.slice(questionSection.index + questionSection[0].length, answerIndex)
    // saveNote writes two separator line endings before the Answer heading. Remove only those so
    // question text that itself ends in a newline still round-trips without being trimmed.
    question = question.replace(/\r?\n\r?\n$/, '')
  }

  let answer = answerSection[1]
  // saveNote adds one terminal newline after the answer; preserve any newline already in the value.
  answer = answer.replace(/(?:\r?\n)$/, '')
  if (!answer) return { ok: false, error: NOTE_READ_ERROR }
  return {
    ok: true,
    kind: 'note',
    title: fields.title || safeName.replace(/\.md$/, ''),
    mode: fields.mode || 'general',
    question,
    answer
  }
}
