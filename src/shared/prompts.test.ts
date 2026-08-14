import { describe, it, expect } from 'vitest'
import {
  RECAP_PROMPT,
  MODE_RECAP_FOCUS,
  recapPromptFor,
  EMAIL_RECAP_PROMPT,
  MEETING_BRIEF_PROMPT,
  WINS_CLAUSE,
  DEFAULT_MODE_PROMPTS,
  ASSIST_PROMPT,
  buildNoDecisionPrompt,
  COLD_CALL_COACHING_PROMPT,
  BOOK_MEETING_PROMPT
} from './prompts'

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
    expect(s).toMatch(/objection/i)
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
    expect(recapPromptFor('presentation')).toMatch(/audience question/i)
    expect(recapPromptFor('support')).toMatch(/reported problem/i)
    expect(recapPromptFor('meeting')).toMatch(/decisions.*owns/i)
    expect(recapPromptFor('cold-call')).toMatch(/objection/i)
  })

  it('focus text never uses banned AI-tell words or em-dashes', () => {
    const banned = /\b(delve|leverage|robust|comprehensive|seamless)\b|—/i
    for (const focus of Object.values(MODE_RECAP_FOCUS)) {
      expect(focus).not.toMatch(banned)
    }
  })
})

describe('email + pre-meeting-brief summary prompts', () => {
  it('the email recap asks for a paste-ready email: subject, next steps, sign-off', () => {
    expect(EMAIL_RECAP_PROMPT).toMatch(/subject/i)
    expect(EMAIL_RECAP_PROMPT).toMatch(/next steps/i)
    expect(EMAIL_RECAP_PROMPT).toMatch(/sign-off/i)
  })

  it('the pre-meeting brief is grounded — its own sections plus a "never invent" guard', () => {
    expect(MEETING_BRIEF_PROMPT).toMatch(/## Who/)
    expect(MEETING_BRIEF_PROMPT).toMatch(/## Open commitments/)
    expect(MEETING_BRIEF_PROMPT).toMatch(/## Talking points/)
    expect(MEETING_BRIEF_PROMPT).toMatch(/never invent|Never invent/)
  })

  it('both carry the humanizer style rules (no AI-tell words, no em-dash)', () => {
    for (const p of [EMAIL_RECAP_PROMPT, MEETING_BRIEF_PROMPT]) {
      expect(p).toMatch(/WRITING STYLE/)
      expect(p).not.toMatch(/—/) // the prompts themselves must not model an em-dash
    }
  })

  it('the wins clause invites only REAL references and can be omitted', () => {
    expect(WINS_CLAUSE).toMatch(/never invent/i)
    expect(WINS_CLAUSE).toMatch(/omit/i) // "if none clearly fits, omit"
  })
})

describe('Cold Calling Mode — coaching + booking prompts', () => {
  it('coaching asks for the four fixed sections, grounded, with the humanizer style', () => {
    for (const heading of ['## What to improve', '## What worked', '## Next steps', '## People to invite or send to']) {
      expect(COLD_CALL_COACHING_PROMPT).toContain(heading)
    }
    expect(COLD_CALL_COACHING_PROMPT).toMatch(/never invent/i)
    expect(COLD_CALL_COACHING_PROMPT).toMatch(/WRITING STYLE/)
    expect(COLD_CALL_COACHING_PROMPT).not.toMatch(/—/)
  })

  it('booking drafts outreach per person and has a clean no-op contract', () => {
    expect(BOOK_MEETING_PROMPT).toMatch(/People to invite or send to/)
    expect(BOOK_MEETING_PROMPT).toMatch(/ready-to-send/i)
    expect(BOOK_MEETING_PROMPT).toContain('NONE')
  })
})

describe('DEFAULT_MODE_PROMPTS', () => {
  const modes = Object.keys(DEFAULT_MODE_PROMPTS)

  it('covers all nine built-in modes', () => {
    expect(modes.sort()).toEqual(
      ['general', 'interview', 'meeting', 'negotiation', 'presentation', 'recruiting', 'sales', 'support', 'cold-call'].sort()
    )
  })

  it('every mode leads with the Métis identity and pins the live-card output format', () => {
    for (const mode of modes) {
      const p = DEFAULT_MODE_PROMPTS[mode]
      expect(p.startsWith('You are Métis')).toBe(true)
      expect(p).toContain('OUTPUT FORMAT')
      expect(p).toContain('"Backup:"')
    }
  })

  it('every mode ends on a grounding rule: never invent, never filler', () => {
    for (const mode of modes) {
      const p = DEFAULT_MODE_PROMPTS[mode]
      expect(p).toMatch(/never invent/i)
      expect(p).toMatch(/never filler/i)
    }
  })

  it('mode prompts never use banned AI-tell words or em-dashes (humanizer discipline)', () => {
    const banned = /\b(delve|leverage|robust|comprehensive|seamless|cutting-edge|best-in-class|synergy|paradigm)\b|—/i
    for (const mode of modes) {
      expect(DEFAULT_MODE_PROMPTS[mode]).not.toMatch(banned)
    }
    expect(ASSIST_PROMPT).not.toMatch(banned)
    expect(buildNoDecisionPrompt('sample transcript')).not.toMatch(banned)
  })

  it('recruiting keeps its interview-sheet backbone, STAR drilling, CHALLENGE, and A-D scoring', () => {
    const p = DEFAULT_MODE_PROMPTS.recruiting
    for (const anchor of ['INTERVIEW SHEET', 'STAR', 'CHALLENGE', 'A to D', 'notice period', 'work permit']) {
      expect(p).toContain(anchor)
    }
  })

  it('assist keeps the exactly-2-sentences contract; honk keeps NUDGE/SAY THIS and the transcript tail', () => {
    expect(ASSIST_PROMPT).toContain('exactly 2 sentences')
    const honk = buildNoDecisionPrompt('x'.repeat(5000))
    expect(honk).toContain('NUDGE:')
    expect(honk).toContain('SAY THIS:')
    expect(honk).toContain('x'.repeat(4000))
    expect(honk).not.toContain('x'.repeat(4001))
  })
})
