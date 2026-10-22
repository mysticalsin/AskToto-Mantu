import { describe, expect, it } from 'vitest'
import { GUARD_LINE, transcriptForPrompt, withContext } from './ask-context'

const TYPED_KEY = 'sk-live-AAAAAAAAAAAAAAAAAAAAAAAA'
const CARD = '4111 1111 1111 1111'

describe('withContext', () => {
  it('redacts secrets in the transcript but never in the typed question', () => {
    const out = withContext(`is ${TYPED_KEY} valid?`, `THEM: my card is ${CARD}`, { redact: true })
    expect(out).toContain(TYPED_KEY)
    expect(out).not.toContain(CARD)
    expect(out).toContain('THEM: my card is')
    expect(out.endsWith(GUARD_LINE)).toBe(true)
  })

  it('leaves the transcript verbatim when redaction is off', () => {
    const out = withContext('what now?', `THEM: my card is ${CARD}`, { redact: false })
    expect(out).toContain(CARD)
  })

  it('keeps only the last 3000 characters of the transcript', () => {
    const tx = `${'a'.repeat(5000)}${'b'.repeat(3000)}`
    const out = withContext('q', tx, { redact: true })
    expect(out).toContain('b'.repeat(3000))
    expect(out).not.toContain('a'.repeat(20))
  })
})

describe('transcriptForPrompt', () => {
  it('slices to the tail before redacting, so a secret cut by the slice is not half-sent', () => {
    const tx = `${CARD} ${'x'.repeat(50)}`
    expect(transcriptForPrompt(tx, 50, true)).toBe('x'.repeat(50))
  })

  it('redacts secrets inside the tail when asked', () => {
    const out = transcriptForPrompt(`THEM: token ${TYPED_KEY} and card ${CARD}`, 4000, true)
    expect(out).not.toContain(CARD)
    expect(out).not.toContain(TYPED_KEY)
  })

  it('returns the raw tail when redaction is off', () => {
    expect(transcriptForPrompt(`card ${CARD}`, 4000, false)).toBe(`card ${CARD}`)
  })
})
