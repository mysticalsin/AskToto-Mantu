/**
 * Per-mode recap section layouts. Single source for recapPromptFor (prompts.ts) and the
 * summary UI (Review + Act 2 demo). Sales / recruiting / meeting (and the other six
 * built-ins) are different section lists, not one skeleton plus a footnote.
 */
import { BUILTIN_MODE_LABELS, CONVERSATION_MODES, type BuiltinMode } from './ipc'

export interface RecapSectionDef {
  /** Stable id (lowercase heading). */
  id: string
  heading: string
  /** Instruction the model sees after "## Heading:". No em-dashes. */
  instruction: string
}

export const MODE_RECAP_LAYOUTS: Record<BuiltinMode, readonly RecapSectionDef[]> = {
  general: [
    { id: 'title', heading: 'Title', instruction: '2 to 4 words naming what was actually discussed, no generic words like "meeting" or "call".' },
    { id: 'tags', heading: 'Tags', instruction: '3 to 5 short topic tags (1-2 words each) as a comma-separated line.' },
    { id: 'overview', heading: 'Overview', instruction: '2 to 3 sentences on what the meeting was and the outcome.' },
    { id: 'topics', heading: 'Topics', instruction: 'the discussion in order, as a tight bulleted timeline.' },
    { id: 'key-qa', heading: 'Key Q&A', instruction: 'every important question asked and the answer given, faithful to the transcript.' },
    { id: 'decisions', heading: 'Decisions', instruction: 'what was decided.' },
    { id: 'action-items', heading: 'Action items', instruction: 'concrete follow-ups, with an owner when stated.' },
    { id: 'open-questions', heading: 'Open questions', instruction: 'what was left unresolved.' },
    { id: 'notable-quotes', heading: 'Notable quotes', instruction: '2 to 5 verbatim lines worth remembering.' }
  ],
  meeting: [
    { id: 'outcome', heading: 'Outcome', instruction: '2 to 3 sentences on where the meeting landed.' },
    { id: 'decisions', heading: 'Decisions', instruction: 'each decision, who owns the follow-through, and the deadline when the transcript states one.' },
    { id: 'action-items', heading: 'Action items', instruction: 'concrete follow-ups, owner and date only when said.' },
    { id: 'open-questions', heading: 'Open questions', instruction: 'what was left unresolved, and what it is waiting on if stated.' },
    { id: 'key-numbers', heading: 'Key numbers', instruction: 'every number, date, and commitment exactly as said.' }
  ],
  sales: [
    { id: 'deal-snapshot', heading: 'Deal snapshot', instruction: 'account, stage, and where the deal stands after this call, from the transcript only.' },
    { id: 'buying-signals', heading: 'Buying signals', instruction: 'interest, urgency, budget, or authority that was actually voiced.' },
    { id: 'objections', heading: 'Objections', instruction: 'each objection and how it was answered.' },
    { id: 'seller-must-know', heading: 'What the seller must know', instruction: 'the facts a seller has to walk away holding: pricing, timeline, competitors, blockers.' },
    { id: 'next-steps', heading: 'Next steps', instruction: 'the moves that advance the deal, with owner and date when stated.' },
    { id: 'stakeholders', heading: 'Stakeholders', instruction: 'named people and their roles when given.' }
  ],
  recruiting: [
    { id: 'candidate', heading: 'Candidate', instruction: 'name if said, current role, and the one-line read of this interview.' },
    { id: 'background', heading: 'Background', instruction: 'education, current role, and reasons to leave. Write "not covered" where silent.' },
    { id: 'motivations', heading: 'Motivations', instruction: 'wishes, drivers, target sector. "not covered" if silent.' },
    { id: 'projects', heading: 'Projects', instruction: 'per engagement: client, duration, context, their personal responsibilities, technical environment.' },
    { id: 'compensation', heading: 'Compensation and contract', instruction: 'current and expected, contract type. Exact numbers only as said.' },
    { id: 'availability', heading: 'Availability', instruction: 'notice, theoretical versus real, mobility, languages.' },
    { id: 'ratings', heading: 'Ratings', instruction: 'Technical, Functional, Personality, Dynamism and Motivation, each A to D with the evidence. "not covered" if silent.' },
    { id: 'strengths-concerns', heading: 'Strengths and concerns', instruction: 'strengths, concerns, red flags, management potential. Never invent a rating.' }
  ],
  interview: [
    { id: 'role', heading: 'Role', instruction: 'the role being discussed, in their words.' },
    { id: 'qa', heading: 'Questions and answers', instruction: 'each question and the substance of the answer, including examples they offered.' },
    { id: 'examples', heading: 'Examples given', instruction: 'concrete stories or metrics the candidate used.' },
    { id: 'next-rounds', heading: 'Next rounds', instruction: 'commitments about next steps, timelines, or follow-ups, only if said.' }
  ],
  negotiation: [
    { id: 'positions', heading: 'Positions', instruction: 'each side\'s stated position.' },
    { id: 'interests', heading: 'Interests', instruction: 'the interests they revealed behind those positions.' },
    { id: 'concessions', heading: 'Concessions', instruction: 'every concession made or extracted, with what triggered it when shown.' },
    { id: 'agreed', heading: 'Agreed terms', instruction: 'terms actually agreed.' },
    { id: 'still-open', heading: 'Still open', instruction: 'terms still open, plus any deadline or walk-away signal that was voiced.' }
  ],
  presentation: [
    { id: 'landed', heading: 'What landed', instruction: 'sections that drew a clear positive reaction in the transcript.' },
    { id: 'audience-questions', heading: 'Audience questions', instruction: 'each question, who asked it when named, and the reply.' },
    { id: 'pushback', heading: 'Confusion or pushback', instruction: 'what caused confusion or pushback. Silence is not approval.' },
    { id: 'follow-ups', heading: 'Follow-ups promised', instruction: 'material, data, or introductions promised, with the recipient when stated.' }
  ],
  support: [
    { id: 'problem', heading: 'Reported problem', instruction: 'the problem in the customer\'s own words.' },
    { id: 'steps-tried', heading: 'Steps tried', instruction: 'troubleshooting in order and what each showed.' },
    { id: 'resolution', heading: 'Resolution', instruction: 'resolved, workaround, or escalation, only as confirmed.' },
    { id: 'follow-ups', heading: 'Follow-ups', instruction: 'every follow-up promised, with timing and any ticket reference mentioned.' }
  ],
  'cold-call': [
    { id: 'how-it-went', heading: 'How the call went', instruction: 'whether it reached the target, how the opener landed, interest versus polite brush-off.' },
    { id: 'objections', heading: 'Objections', instruction: 'every objection and how it was met.' },
    { id: 'qualifying', heading: 'Qualifying facts', instruction: 'facts learned about the prospect.' },
    { id: 'commitment', heading: 'Commitment', instruction: 'any commitment made, with a date when one was given.' }
  ]
}

export function recapLayoutFor(mode: string): readonly RecapSectionDef[] {
  if (Object.prototype.hasOwnProperty.call(MODE_RECAP_LAYOUTS, mode)) return MODE_RECAP_LAYOUTS[mode as BuiltinMode]
  return MODE_RECAP_LAYOUTS.general
}

export function recapLayoutHeadings(mode: string): string[] {
  return recapLayoutFor(mode).map((s) => `## ${s.heading}:`)
}

/** Every built-in mode is listed, in BUILTIN_MODE_LABELS order. */
export function allBuiltinRecapModes(): BuiltinMode[] {
  return CONVERSATION_MODES.slice()
}

export function builtinModeLabel(mode: BuiltinMode): string {
  return BUILTIN_MODE_LABELS[mode]
}

export interface SplitRecapSection {
  heading: string
  body: string
}

/** Split a recap markdown doc on `## ` headings (same shape parseRecapMarkdown uses). */
export function splitRecapSections(markdown: string): SplitRecapSection[] {
  const md = typeof markdown === 'string' ? markdown : ''
  const out: SplitRecapSection[] = []
  for (const part of md.split(/^##\s+/m)) {
    const nl = part.indexOf('\n')
    const headRaw = (nl === -1 ? part : part.slice(0, nl)).trim()
    const body = nl === -1 ? '' : part.slice(nl + 1).trim()
    const heading = headRaw.replace(/:\s*$/, '').trim()
    if (heading) out.push({ heading, body })
  }
  return out
}
