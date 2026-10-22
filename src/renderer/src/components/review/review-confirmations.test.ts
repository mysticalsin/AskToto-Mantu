import { describe, expect, it } from 'vitest'
import { PUSH_FAILED_COPY, REPLACE_EDITED_NOTES_CONFIRMATION } from './review-confirmations'

describe('Review confirmations follow the HIG alert rules (Q07, D4-3)', () => {
  const c = REPLACE_EDITED_NOTES_CONFIRMATION

  it('asks a question, explains the consequence in a sentence, and names a short title-style verb', () => {
    expect(c.title).toBe('Replace your edited notes?')
    expect(c.message).toMatch(/^[A-Z].*\.$/)
    expect(c.message).not.toContain('—')
    expect(c.confirmLabel.split(' ').length).toBeLessThanOrEqual(3)
    for (const word of c.confirmLabel.split(' ')) expect(word[0]).toBe(word[0].toUpperCase())
    expect(c.confirmLabel).not.toMatch(/^(Yes|No|OK|Ok)$/)
  })

  it('is destructive, because losing the edits is not the part the person chose', () => {
    expect(c.destructive).toBe(true)
  })

  it('keeps the push failure copy a plain sentence with a way forward', () => {
    expect(PUSH_FAILED_COPY).toBe('Push failed. Try again.')
  })
})
