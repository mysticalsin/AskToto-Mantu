export type AnswerFeedback = { rating: 'up' | 'down'; kind?: string; askId?: string }

/** On-device eval metrics aggregated from the local audit log (no content, never shipped). */
export interface EvalMetrics {
  answers: number
  ttftP50Ms: number | null
  ttftP95Ms: number | null
  answerP50Ms: number | null
  answerP95Ms: number | null
  acceptance: { up: number; down: number; rate: number | null }
  failures: number
  fallbacks: number
  tokensIn: number
  tokensOut: number
  byProvider: Record<string, number>
  /** Wave 3 (docs/qa/QUALITY-SCORECARD.md's "Brain LLM consolidations / active day"): count of
   *  'brain.consolidation' audit events in this window — how many batched extraction passes actually
   *  ran, as opposed to the per-mode provider.request counts above. */
  brainConsolidationPasses: number
}

export type AskMode = 'answer' | 'vision' | 'suggest' | 'summary' | 'recap'

export const CONVERSATION_MODES = [
  'interview',
  'recruiting',
  'meeting',
  'sales',
  'negotiation',
  'presentation',
  'support',
  'general',
  'cold-call'
] as const
/** The 9 built-in modes. */
export type BuiltinMode = (typeof CONVERSATION_MODES)[number]
/** Active mode id: a built-in id OR a user-created custom mode id. The `(string & {})` keeps literal
 *  autocomplete for built-ins while accepting any custom id, so existing consumers compile unchanged. */
export type ConversationMode = BuiltinMode | (string & {})

/** Display labels for the 9 built-in modes (single source of truth, shared by ModePicker + Settings + bar). */
export const BUILTIN_MODE_LABELS: Record<BuiltinMode, string> = {
  general: 'General',
  interview: 'Interview',
  recruiting: 'Recruiting',
  meeting: 'Meeting',
  sales: 'Sales',
  negotiation: 'Negotiation',
  presentation: 'Presentation',
  support: 'Support',
  'cold-call': 'Cold Calling'
}

/** A user-created custom mode (id + display label). Its prompt lives in settings.modePrompts[id] and its
 *  context files in settings.contextDocs[id]. Built-in modes are never stored here. */
export interface CustomMode { id: string; label: string }

/** Cluely-style ordered groups for the modes list (built-ins). Custom modes render under their own group in the UI. */
export const MODE_GROUPS: { label: string; modes: BuiltinMode[] }[] = [
  { label: 'General', modes: ['general'] },
  { label: 'Live assist', modes: ['interview', 'recruiting', 'sales', 'negotiation', 'presentation', 'support', 'cold-call'] },
  { label: 'Meetings', modes: ['meeting'] }
]

/** Resolve a mode id (built-in or custom) to its display label. */
export function modeLabel(id: string, customModes: CustomMode[] = []): string {
  if (Object.prototype.hasOwnProperty.call(BUILTIN_MODE_LABELS, id)) return BUILTIN_MODE_LABELS[id as BuiltinMode]
  return customModes.find((m) => m.id === id)?.label ?? id
}
