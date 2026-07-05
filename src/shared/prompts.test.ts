import { describe, it, expect } from 'vitest'
import { RECAP_PROMPT, MODE_RECAP_FOCUS, recapPromptFor } from './prompts'

// Section skeleton transcripts.ts / recall.ts depend on (see prompts.ts's RECAP_PROMPT doc comment).
// This exact list, in this exact order, must never change shape when mode focus is appended.
const RECAP_SECTION_HEADINGS = [
  '## Title:',
  '## Tags:',
  '## Overview:',
  '## Topics:',
  '## Key Q&A:',
  '## Decisions:',
  '## Action items:',
  '## Open questions:',
  '## Notable quotes:'
]

describe('recapPromptFor', () => {
  it('sales: contains the unchanged section skeleton AND the sales focus block', () => {
    const s = recapPromptFor('sales')
    for (const heading of RECAP_SECTION_HEADINGS) expect(s).toContain(heading)
    expect(s).toContain('MODE FOCUS (Sales)')
    expect(s).toMatch(/buying signals/i)
    expect(s).toMatch(/objections/i)
  })

  it('general returns the plain recap base, unchanged', () => {
    expect(recapPromptFor('general')).toBe(RECAP_PROMPT)
    expect(recapPromptFor('general')).not.toContain('MODE FOCUS')
  })

  it('an unknown custom mode id falls back to the plain recap base', () => {
    const s = recapPromptFor('my-custom-mode-id')
    expect(s).toBe(RECAP_PROMPT)
    expect(s).not.toContain('MODE FOCUS')
  })

  it('every built-in mode with a focus keeps the section skeleton intact', () => {
    for (const mode of Object.keys(MODE_RECAP_FOCUS)) {
      const s = recapPromptFor(mode)
      for (const heading of RECAP_SECTION_HEADINGS) expect(s).toContain(heading)
    }
  })

  it('interview, negotiation, presentation, support each append their own distinct focus', () => {
    expect(recapPromptFor('interview')).toMatch(/candidate-relevant exchanges/i)
    expect(recapPromptFor('negotiation')).toMatch(/positions.*interests/i)
    expect(recapPromptFor('presentation')).toMatch(/audience questions/i)
    expect(recapPromptFor('support')).toMatch(/reported problem/i)
    expect(recapPromptFor('meeting')).toMatch(/decisions.*owns/i)
  })

  it('focus text never uses banned AI-tell words or em-dashes', () => {
    const banned = /\b(delve|leverage|robust|comprehensive|seamless)\b|—/i
    for (const focus of Object.values(MODE_RECAP_FOCUS)) {
      expect(focus).not.toMatch(banned)
    }
  })
})
