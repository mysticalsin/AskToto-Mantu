import type { TranscriptLine } from '@shared/transcript-line'

/** Synthetic only (G78): invented people and projects, never real meeting text. */
export const LUMEN_RECAP = [
  '## Title: "Project Lumen Planning"',
  '## Overview',
  'The synthetic team planned the Lumen launch.',
  '## Decisions',
  '- Launch Project Lumen in a staged rollout',
  '## Action items',
  '- Prepare the vendor contract (Alex)',
  '- Send the pilot invite by Friday - Sam',
  '- Book the training room (Jordan)',
  '## Open questions',
  '- Who owns the rollback drill?'
].join('\n')

export const LUMEN_LINES: TranscriptLine[] = [
  { speaker: 'them', text: 'Welcome everyone to the Lumen planning call.', t: 1000, utteranceId: 'u0' },
  { speaker: 'you', text: 'We will launch Project Lumen in a staged rollout.', t: 2000, utteranceId: 'u1' },
  { speaker: 'them', text: 'Alex will prepare the vendor contract this week.', t: 3000, utteranceId: 'u2' },
  { speaker: 'you', text: 'Please send the pilot invite by Friday.', t: 4000, name: 'Sam', utteranceId: 'u3' },
  { speaker: 'them', text: 'Nobody has said who owns the rollback drill yet.', t: 5000, utteranceId: 'u4' }
]
