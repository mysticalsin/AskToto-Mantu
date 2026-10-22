import type { RecapExport, SaveMeeting } from '@shared/ipc'

/**
 * GATE-05 golden meetings (G21, R112). Every string here is synthetic: invented people, invented projects,
 * no real meeting content. Each fixture carries the structure that must come back from save -> recap ->
 * exports -> reopen, so a change to any step shows up as a diff against these literals.
 */
export interface GoldenMeeting {
  /** Stable label used in test names. */
  id: string
  meeting: SaveMeeting
  /** What the recap parser must hand to the JSON export (markdown is filled in from the recap itself). */
  expectedExport: Omit<RecapExport, 'markdown'>
  /** Every fact that must appear exactly once in the plain export (decoded file text). */
  uniqueFacts: string[]
  /** Terms a keyword search must find this meeting with. */
  searchTerm: string
}

const T0 = Date.UTC(2026, 9, 5, 14, 0, 0)

export const ALPHA_RECAP = [
  '## Title: "Synthetic Alpha Launch Sync"',
  '## Tags: alpha, launch, synthetic-fixture',
  '## Overview',
  'The team reviewed the synthetic Alpha launch plan and agreed on a staged rollout.',
  '## Topics',
  '- Rollout stages',
  '- Support readiness',
  '## Key Q&A',
  '- Is the pilot ready? Yes, pending sign-off.',
  '## Decisions',
  '- Ship the pilot to the synthetic Orchid cohort first',
  '- Freeze scope on 2 November',
  '## Action items',
  '- Draft the rollout checklist (Ana)',
  '- Send the pilot invite by Friday - Ben',
  '- Confirm the support rota',
  '## Open questions',
  '- Who owns the synthetic rollback drill?',
  '## Notable quotes',
  '- "Staged beats big-bang."'
].join('\n')

export const ALPHA: GoldenMeeting = {
  id: 'english-sync',
  meeting: {
    title: 'alpha sync',
    mode: 'meeting',
    startedAt: T0,
    durationMs: 25 * 60_000,
    lines: [
      { speaker: 'them', text: 'Let us walk through the Alpha rollout stages.', t: T0 },
      { speaker: 'you', text: 'Orchid cohort first, then the wider pilot.', t: T0 + 20_000 },
      { speaker: 'them', text: 'Agreed. Scope freezes on 2 November.', t: T0 + 45_000 },
      { speaker: 'you', text: 'Ana drafts the checklist, Ben sends the invite.', t: T0 + 70_000 }
    ],
    recap: ALPHA_RECAP,
    recapStatus: 'complete'
  },
  expectedExport: {
    title24: 'Synthetic Alpha Launch Sync',
    tags: ['alpha', 'launch', 'synthetic-fixture'],
    overview: 'The team reviewed the synthetic Alpha launch plan and agreed on a staged rollout.',
    topics: ['Rollout stages', 'Support readiness'],
    keyQA: ['Is the pilot ready? Yes, pending sign-off.'],
    decisions: ['Ship the pilot to the synthetic Orchid cohort first', 'Freeze scope on 2 November'],
    actionItems: [
      { text: 'Draft the rollout checklist', owner: 'Ana', dueDateText: null },
      { text: 'Send the pilot invite', owner: 'Ben', dueDateText: 'Friday' },
      { text: 'Confirm the support rota', owner: null, dueDateText: null }
    ],
    openQuestions: ['Who owns the synthetic rollback drill?'],
    notableQuotes: ['"Staged beats big-bang."']
  },
  uniqueFacts: [
    'Let us walk through the Alpha rollout stages.',
    'Orchid cohort first, then the wider pilot.',
    'Agreed. Scope freezes on 2 November.',
    'Ana drafts the checklist, Ben sends the invite.',
    'Ship the pilot to the synthetic Orchid cohort first',
    'Who owns the synthetic rollback drill?'
  ],
  searchTerm: 'orchid'
}

export const FRENCH_RECAP = [
  "## Titre: Réunion d'équipe synthétique",
  '## Étiquettes: planification, été',
  '## Synthèse',
  "L'équipe fictive a validé le calendrier de l'été.",
  '## Décisions',
  '- Garder le lancement au 15 juillet',
  '## Actions à mener',
  '- Préparer le dossier de presse (Camille)',
  '## Questions ouvertes',
  '- Qui valide le budget fictif ?'
].join('\n')

export const FRENCH: GoldenMeeting = {
  id: 'french-accents',
  meeting: {
    title: 'réunion fictive',
    mode: 'meeting',
    startedAt: T0 + 86_400_000,
    durationMs: 12 * 60_000,
    lines: [
      { speaker: 'them', text: "Le calendrier de l'été est-il tenable ?", t: T0 + 86_400_000, lang: 'French' },
      { speaker: 'you', text: 'Oui, à condition de garder le 15 juillet.', t: T0 + 86_430_000, lang: 'French' }
    ],
    recap: FRENCH_RECAP,
    recapStatus: 'complete'
  },
  expectedExport: {
    title24: "Réunion d'équipe synthétique",
    tags: ['planification', 'été'],
    overview: "L'équipe fictive a validé le calendrier de l'été.",
    topics: [],
    keyQA: [],
    decisions: ['Garder le lancement au 15 juillet'],
    actionItems: [{ text: 'Préparer le dossier de presse', owner: 'Camille', dueDateText: null }],
    openQuestions: ['Qui valide le budget fictif ?'],
    notableQuotes: []
  },
  uniqueFacts: [
    "Le calendrier de l'été est-il tenable ?",
    'Oui, à condition de garder le 15 juillet.',
    'Garder le lancement au 15 juillet'
  ],
  searchTerm: 'calendrier'
}

/** A quick note-taker meeting saved before any recap exists, with markup-looking speech that must survive as text. */
export const NOTES_ONLY: GoldenMeeting = {
  id: 'notes-without-recap',
  meeting: {
    title: 'quick notes',
    mode: 'meeting',
    startedAt: T0 + 2 * 86_400_000,
    durationMs: 5 * 60_000,
    lines: [
      { speaker: 'them', text: 'Remember <b>bold</b> & the "quoted" budget line.', t: T0 + 2 * 86_400_000 },
      { speaker: 'you', text: 'Will note: Zephyr budget needs a second look.', t: T0 + 2 * 86_400_000 + 15_000 }
    ],
    recap: ''
  },
  expectedExport: {
    title24: '',
    tags: [],
    overview: '',
    topics: [],
    keyQA: [],
    decisions: [],
    actionItems: [],
    openQuestions: [],
    notableQuotes: []
  },
  uniqueFacts: ['Remember <b>bold</b> & the "quoted" budget line.', 'Will note: Zephyr budget needs a second look.'],
  searchTerm: 'zephyr'
}

export const GOLDEN_MEETINGS: readonly GoldenMeeting[] = [ALPHA, FRENCH, NOTES_ONLY]

/** Count non-overlapping occurrences of `needle` in `haystack`. */
export function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  return haystack.split(needle).length - 1
}
