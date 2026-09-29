/**
 * State list of the design-capture surface, with neutral sample data only. The capture job reads
 * `DESIGN_STATE_IDS` from the running page, so this list is the single source of what gets screenshotted.
 * These are placeholder states for the capture pipeline, not the M2-0201 prototype state list.
 *
 * BLOCKED_EXTERNAL: the lead supplies the M2-0201 prototype manifest state ids from the program tracker; they
 * replace `DESIGN_STATES` in this file one to one before the capture job's artifact is filed as M2-0201 evidence.
 */
export type DesignPhase = 'idle' | 'listening'

export type DesignState =
  | { id: 'bar-idle'; kind: 'bar'; title: string; phase: 'idle' }
  | { id: 'bar-listening'; kind: 'bar'; title: string; phase: 'listening' }
  | { id: 'answer-streaming'; kind: 'answer'; title: string; streaming: true }
  | { id: 'answer-complete'; kind: 'answer'; title: string; streaming: false }
  | { id: 'review-summary'; kind: 'review'; title: string }
  | { id: 'error-recoverable'; kind: 'error'; title: string }

export const DESIGN_STATES: readonly DesignState[] = [
  { id: 'bar-idle', kind: 'bar', title: 'Bar, idle', phase: 'idle' },
  { id: 'bar-listening', kind: 'bar', title: 'Bar, listening', phase: 'listening' },
  { id: 'answer-streaming', kind: 'answer', title: 'Answer, streaming', streaming: true },
  { id: 'answer-complete', kind: 'answer', title: 'Answer, complete', streaming: false },
  { id: 'review-summary', kind: 'review', title: 'Review, summary' },
  { id: 'error-recoverable', kind: 'error', title: 'Error, recoverable' }
]

export const DESIGN_STATE_IDS: readonly string[] = DESIGN_STATES.map((s) => s.id)

export const SAMPLE_QUESTION = 'What did we agree about the sample rollout?'
export const SAMPLE_ANSWER = [
  'The sample rollout starts with a small pilot group.',
  'Owners review the pilot results before the wider launch.'
]
export const SAMPLE_REVIEW = {
  title: 'Sample planning meeting',
  decisions: ['Start with a small pilot group', 'Review results before the wider launch'],
  actions: ['Owner A drafts the pilot checklist', 'Owner B schedules the review']
}

/** The state named by a `?state=<id>` query string, or undefined when absent or not in the list. */
export function resolveDesignState(search: string): DesignState | undefined {
  const id = new URLSearchParams(search).get('state')
  return DESIGN_STATES.find((s) => s.id === id)
}
