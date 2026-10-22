import { describe, expect, it } from 'vitest'
import { GUARD_LINE, LAST_THEM_SLOT, TRANSCRIPT_SLOT } from './ask-context'
import { buildFactCheckRequest } from './fact-check-request'

const CARD = '4111 1111 1111 1111'

describe('buildFactCheckRequest', () => {
  it('transcript-only fact-check asks main for a bounded tail through a slot and is flagged for redaction', () => {
    const transcript = `${'a'.repeat(7000)}${'b'.repeat(3000)}`
    const req = buildFactCheckRequest({ claim: '', transcript, listening: true })
    expect(req).not.toBeNull()
    expect(req!.redactPrompt).toBe(true)
    expect(req!.label).toBe('Fact-check: the conversation so far')
    expect(req!.prompt.endsWith(GUARD_LINE)).toBe(true)
    // The renderer puts no transcript text in the prompt: main fills the slot with at most 3000 characters.
    expect(req!.prompt).toContain(TRANSCRIPT_SLOT)
    expect(req!.prompt).not.toContain('b'.repeat(10))
    expect(req!.context).toEqual({ kind: 'manual', tailChars: 3000, requireTranscript: true })
    expect(req!.historyTurn).toBeUndefined()
    expect(req!.useHistory).toBe(false)
  })

  it('bounds a leftover transcript after the meeting ended (not listening) the same way', () => {
    const req = buildFactCheckRequest({ claim: '', transcript: 'x'.repeat(10_000), listening: false })
    expect(req!.redactPrompt).toBe(true)
    expect(req!.prompt).not.toContain('x'.repeat(10))
    expect(req!.context?.tailChars).toBe(3000)
  })

  it('prefers the last THEM line (via its slot), labels with it, and still flags the prompt for redaction', () => {
    const req = buildFactCheckRequest({
      claim: '',
      lastThem: `we shipped to 40 countries, card ${CARD}`,
      transcript: 'whole meeting',
      listening: true
    })
    expect(req!.label).toBe(`Fact-check: "we shipped to 40 countries, card ${CARD}"`)
    expect(req!.redactPrompt).toBe(true)
    expect(req!.prompt).toContain(LAST_THEM_SLOT)
    expect(req!.prompt).not.toContain(TRANSCRIPT_SLOT)
    // Neither the line nor the meeting is in the prompt the renderer builds.
    expect(req!.prompt).not.toContain('we shipped to 40 countries')
    expect(req!.prompt).not.toContain('whole meeting')
  })

  it('sends a typed claim unredacted and unflagged', () => {
    const req = buildFactCheckRequest({
      claim: 'the sky is green',
      lastThem: 'other',
      transcript: 't',
      listening: false
    })
    expect(req!.redactPrompt).toBeUndefined()
    expect(req!.context).toBeUndefined()
    expect(req!.label).toBe('the sky is green')
    expect(req!.prompt).toContain('the sky is green')
    expect(req!.useHistory).toBe(true)
    expect(req!.historyTurn).toBe('the sky is green')
  })

  it('does not record or replay history for a typed claim during a live call (as before)', () => {
    const req = buildFactCheckRequest({ claim: 'x is true', transcript: 't', listening: true })
    expect(req!.useHistory).toBe(false)
    expect(req!.historyTurn).toBeUndefined()
    expect(req!.redactPrompt).toBeUndefined()
  })

  it('returns null when there is nothing to check', () => {
    expect(buildFactCheckRequest({ claim: '', transcript: '   ', listening: false })).toBeNull()
  })
})
