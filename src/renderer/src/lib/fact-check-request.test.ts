import { describe, expect, it } from 'vitest'
import { GUARD_LINE } from './ask-context'
import { buildFactCheckRequest } from './fact-check-request'

const CARD = '4111 1111 1111 1111'

describe('buildFactCheckRequest', () => {
  it('transcript-only fact-check is bounded and redacted', () => {
    const transcript = `${'a'.repeat(7000)}${'b'.repeat(3000)}`
    const req = buildFactCheckRequest({ claim: '', transcript, listening: true })
    expect(req).not.toBeNull()
    expect(req!.redactPrompt).toBe(true)
    expect(req!.label).toBe('Fact-check: the conversation so far')
    expect(req!.prompt.endsWith(GUARD_LINE)).toBe(true)
    // At most 3000 transcript chars reach the prompt: none of the older 'a' run may appear.
    expect(req!.prompt).toContain('b'.repeat(3000))
    expect(req!.prompt).not.toContain('a'.repeat(10))
    expect(req!.historyTurn).toBeUndefined()
    expect(req!.useHistory).toBe(false)
  })

  it('bounds a leftover transcript after the meeting ended (not listening) the same way', () => {
    const req = buildFactCheckRequest({ claim: '', transcript: 'x'.repeat(10_000), listening: false })
    expect(req!.redactPrompt).toBe(true)
    expect(req!.prompt).not.toContain('x'.repeat(3001))
  })

  it('prefers the last THEM line, labels with it, and still flags the prompt for redaction', () => {
    const req = buildFactCheckRequest({
      claim: '',
      lastThem: `we shipped to 40 countries, card ${CARD}`,
      transcript: 'whole meeting',
      listening: true
    })
    expect(req!.label).toBe(`Fact-check: "we shipped to 40 countries, card ${CARD}"`)
    expect(req!.redactPrompt).toBe(true)
    expect(req!.prompt).toContain('we shipped to 40 countries')
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
