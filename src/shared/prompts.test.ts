import { describe, it, expect } from 'vitest'
import {
  RECAP_PROMPT,
  recapPromptFor,
  EMAIL_RECAP_PROMPT,
  MEETING_BRIEF_PROMPT,
  WINS_CLAUSE,
  DEFAULT_MODE_PROMPTS,
  retargetForTypedAsk,
  ASSIST_PROMPT,
  buildNoDecisionPrompt,
  COLD_CALL_COACHING_PROMPT,
  BOOK_MEETING_PROMPT
} from './prompts'
import { MODE_RECAP_LAYOUTS, recapLayoutHeadings } from './mode-recap'
import { CONVERSATION_MODES } from './ipc'

describe('recapPromptFor', () => {
  it('sales vs recruiting vs meeting are different section layouts, not one skeleton plus a footnote', () => {
    const sales = recapPromptFor('sales')
    const recruiting = recapPromptFor('recruiting')
    const meeting = recapPromptFor('meeting')
    expect(sales).not.toContain('MODE FOCUS')
    expect(recruiting).not.toContain('MODE FOCUS')
    expect(meeting).not.toContain('MODE FOCUS')
    expect(sales).toContain('## What the seller must know:')
    expect(sales).toContain('## Next steps:')
    expect(sales).not.toContain('## Ratings:')
    expect(recruiting).toContain('## Ratings:')
    expect(recruiting).toContain('## Strengths and concerns:')
    expect(recruiting).not.toContain('## What the seller must know:')
    expect(meeting).toContain('## Decisions:')
    expect(meeting).toContain('## Action items:')
    expect(meeting).toContain('## Key numbers:')
    expect(meeting).not.toContain('## What the seller must know:')
    expect(meeting).not.toContain('## Ratings:')
    expect(sales).not.toBe(recruiting)
    expect(sales).not.toBe(meeting)
    expect(recruiting).not.toBe(meeting)
  })

  it('an unknown custom mode id falls back to the plain recap base', () => {
    const s = recapPromptFor('my-custom-mode-id')
    expect(s).toBe(RECAP_PROMPT)
    expect(s).not.toContain('MODE FOCUS')
  })

  it('every built-in mode has its own layout and recapPromptFor uses those headings', () => {
    for (const mode of CONVERSATION_MODES) {
      const s = recapPromptFor(mode)
      for (const heading of recapLayoutHeadings(mode)) expect(s).toContain(heading)
      expect(MODE_RECAP_LAYOUTS[mode].length).toBeGreaterThanOrEqual(4)
    }
  })

  it('interview, negotiation, presentation, support, cold-call each have distinct headings', () => {
    expect(recapPromptFor('interview')).toContain('## Questions and answers:')
    expect(recapPromptFor('negotiation')).toContain('## Positions:')
    expect(recapPromptFor('presentation')).toContain('## Audience questions:')
    expect(recapPromptFor('support')).toContain('## Reported problem:')
    expect(recapPromptFor('cold-call')).toContain('## How the call went:')
  })

  it('layout instructions never use banned AI-tell words or em-dashes', () => {
    const banned = /\b(delve|leverage|robust|comprehensive|seamless)\b|—/i
    for (const layout of Object.values(MODE_RECAP_LAYOUTS)) {
      for (const section of layout) {
        expect(section.instruction).not.toMatch(banned)
        expect(section.heading).not.toMatch(banned)
      }
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

describe('typed asks get a written output format, not the spoken one', () => {
  const modes = Object.keys(DEFAULT_MODE_PROMPTS) as (keyof typeof DEFAULT_MODE_PROMPTS)[]

  it('every mode prompt exposes exactly one replaceable OUTPUT FORMAT block', () => {
    // retargetForTypedAsk depends on this uniform shape; a mode that drifts would silently keep its
    // spoken format on typed asks, which is the whole bug being fixed.
    for (const m of modes) {
      const occurrences = DEFAULT_MODE_PROMPTS[m].match(/OUTPUT FORMAT/g) ?? []
      expect(occurrences).toHaveLength(1)
      expect(retargetForTypedAsk(DEFAULT_MODE_PROMPTS[m])).not.toBe(DEFAULT_MODE_PROMPTS[m])
    }
  })

  it('drops the spoken framing and the Backup line from every mode FORMAT section', () => {
    for (const m of modes) {
      const typed = retargetForTypedAsk(DEFAULT_MODE_PROMPTS[m])
      const section = /OUTPUT FORMAT\n[\s\S]*?(?=\n\n)/.exec(typed)?.[0] ?? ''
      expect(section).not.toMatch(/say out loud/i)
      expect(section).not.toMatch(/seconds/i)
      expect(section).toContain('Lead with the answer itself')
      // The "Backup:" line is only ever specified in the format section, so it goes with it.
      expect(typed).not.toContain('"Backup:"')
    }
  })

  it("general — the default mode — carries no spoken framing at all once retargeted", () => {
    // Other modes (interview/sales/negotiation) legitimately keep a spoken intro: even a typed ask
    // there means "give me the line to say". `general` is the one that must read as a written answer.
    const typed = retargetForTypedAsk(DEFAULT_MODE_PROMPTS.general)
    expect(typed).not.toMatch(/say out loud/i)
    expect(typed).not.toMatch(/seconds/i)
  })

  it('keeps the rest of the persona intact — only the format section changes', () => {
    const typed = retargetForTypedAsk(DEFAULT_MODE_PROMPTS.recruiting)
    for (const anchor of ['INTERVIEW SHEET', 'STAR', 'CHALLENGE', 'A to D', 'notice period']) {
      expect(typed).toContain(anchor)
    }
    expect(typed.startsWith('You are Métis')).toBe(true)
  })

  it('leaves a custom prompt with no OUTPUT FORMAT section untouched', () => {
    const custom = 'You are my own assistant. Answer however I asked.'
    expect(retargetForTypedAsk(custom)).toBe(custom)
  })
})
