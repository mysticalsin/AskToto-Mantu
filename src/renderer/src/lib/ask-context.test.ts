import { describe, expect, it } from 'vitest'
import { AskContextRequestSchema } from '@shared/session-context-request'
import {
  GUARD_LINE,
  LAST_THEM_SLOT,
  TRANSCRIPT_SLOT,
  assistPrompt,
  explainAsk,
  fieldContext,
  noDecisionAsk,
  promptContext,
  screenRunContext,
  withContext
} from './ask-context'

// Redaction and the tail bound of a transcript-bearing prompt are main's job now (the renderer holds no text to
// redact in a prompt); their tests live with applyAskContext in main/features/session-context/ask-context.test.ts.

describe('withContext', () => {
  it('keeps the typed question verbatim and puts a slot, not transcript text, where the transcript goes', () => {
    const out = withContext('is sk-live-AAAAAAAAAAAAAAAAAAAAAAAA valid?')
    expect(out.startsWith('is sk-live-AAAAAAAAAAAAAAAAAAAAAAAA valid?')).toBe(true)
    expect(out).toContain(`"""\n${TRANSCRIPT_SLOT}\n"""`)
    expect(out.endsWith(GUARD_LINE)).toBe(true)
  })
})

describe('context declarations', () => {
  it('promptContext asks for a bounded tail and, by default, refuses an ask with no transcript', () => {
    expect(promptContext('manual', 3000)).toEqual({ kind: 'manual', tailChars: 3000, requireTranscript: true })
    expect(promptContext('manual', 4000, false)).toEqual({ kind: 'manual', tailChars: 4000, requireTranscript: false })
  })

  it('fieldContext asks main to fill the request transcript field', () => {
    expect(fieldContext('conversation')).toEqual({ kind: 'conversation', field: true, tailChars: 6000 })
  })

  it('every declaration the renderer builds is accepted by the schema main parses with', () => {
    for (const declared of [
      promptContext('manual', 3000),
      promptContext('screen', 4000, false),
      fieldContext('conversation'),
      noDecisionAsk().context,
      explainAsk('', true).context,
      screenRunContext(withContext('q'), 'screen', true)
    ]) {
      expect(AskContextRequestSchema.safeParse(declared).success).toBe(true)
    }
  })
})

describe('screenRunContext', () => {
  it('declares nothing for a prompt with no slot, so a typed screen ask is never given transcript context', () => {
    expect(screenRunContext('Help me with what is on my screen.', 'screen')).toBeUndefined()
  })

  it('declares the slot context at the run kind when the prompt carries a slot', () => {
    expect(screenRunContext(withContext('Explain my screen.'), 'screen')).toEqual({
      kind: 'screen',
      tailChars: 3000,
      requireTranscript: false
    })
    expect(screenRunContext(withContext('Explain my screen.'), 'manual')?.kind).toBe('manual')
  })

  it('fuses recent speech on the fast path whether or not the prompt has a slot', () => {
    expect(screenRunContext('plain', 'screen', true)).toEqual({ kind: 'screen', field: true, tailChars: 6000 })
    expect(screenRunContext(withContext('q'), 'screen', true)).toMatchObject({
      kind: 'screen',
      field: true,
      tailChars: 3000
    })
  })
})

describe('transcript-bearing asks carry slots and declarations, never transcript text', () => {
  it('assist and the no-decision nudge', () => {
    expect(assistPrompt()).toContain(TRANSCRIPT_SLOT)
    expect(assistPrompt().endsWith(GUARD_LINE)).toBe(true)
    const nudge = noDecisionAsk()
    expect(nudge.prompt).toContain(TRANSCRIPT_SLOT)
    expect(nudge).toMatchObject({
      mode: 'answer',
      redactPrompt: true,
      context: { kind: 'conversation', tailChars: 4000 }
    })
    expect(nudge.transcript).toBeUndefined()
  })

  it('explain: typed text stands alone, a transcript explain uses the slot and is redacted by main', () => {
    const typed = explainAsk('what is a SAFE note?', true)
    expect(typed.prompt).toContain('what is a SAFE note?')
    expect(typed.prompt).not.toContain(TRANSCRIPT_SLOT)
    expect(typed.redactPrompt).toBe(false)
    expect(typed.context).toBeUndefined()
    const fromTranscript = explainAsk('', true)
    expect(fromTranscript.prompt).toContain(TRANSCRIPT_SLOT)
    expect(fromTranscript.redactPrompt).toBe(true)
    expect(fromTranscript.context).toEqual({ kind: 'manual', tailChars: 3000, requireTranscript: true })
    const generic = explainAsk('', false)
    expect(generic.prompt).not.toContain(TRANSCRIPT_SLOT)
    expect(generic.context).toBeUndefined()
  })

  it('the last-THEM slot is a distinct token', () => {
    expect(LAST_THEM_SLOT).not.toBe(TRANSCRIPT_SLOT)
  })
})
