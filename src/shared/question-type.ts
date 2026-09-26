/**
 * Question-type classification for the Operator dashboard.
 *
 * Pure, deterministic, offline. Runs on the seat at Ask time so the fleet dashboard can show WHAT KIND of
 * questions people ask without the question text ever leaving the device (text is a separate opt-in).
 *
 * Contract:
 *  - Never throws. Any input (undefined, non-string, giant, binary) yields a type from QUESTION_TYPES.
 *  - Only the label crosses the wire. No substring of the prompt is ever part of the result.
 *  - Unknown or empty input is 'unknown', never a guess. The dashboard reports coverage honestly.
 *  - The taxonomy is closed: the Worker rejects anything not in QUESTION_TYPES (see normalizeQuestionType).
 */

export const QUESTION_TYPES = [
  'factual',
  'how-to',
  'explain',
  'compare',
  'summarize',
  'draft',
  'translate',
  'code',
  'estimate',
  'decision',
  'screen',
  'behavioral',
  'other',
  'unknown'
] as const

export type QuestionType = (typeof QUESTION_TYPES)[number]

/** Human labels for the console. Single source of truth for the Worker UI. */
export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  factual: 'Factual',
  'how-to': 'How to',
  explain: 'Explain',
  compare: 'Compare',
  summarize: 'Summarize',
  draft: 'Draft',
  translate: 'Translate',
  code: 'Code',
  estimate: 'Estimate',
  decision: 'Decision',
  screen: 'Screen',
  behavioral: 'Behavioral',
  other: 'Other',
  unknown: 'Unknown'
}

const QUESTION_TYPE_SET: ReadonlySet<string> = new Set(QUESTION_TYPES)

export function isQuestionType(v: unknown): v is QuestionType {
  return typeof v === 'string' && QUESTION_TYPE_SET.has(v)
}

/**
 * Wire-side guard. Anything outside the closed taxonomy collapses to 'unknown' so a tampered or future
 * client can never write a free-form string into the fleet store. Case and whitespace are forgiven.
 */
export function normalizeQuestionType(v: unknown): QuestionType {
  if (typeof v !== 'string') return 'unknown'
  const s = v.trim().toLowerCase()
  return isQuestionType(s) ? s : 'unknown'
}

/** Longest prompt the heuristics look at. Anything past this is ignored, never an error. */
const MAX_SCAN = 2_000

/**
 * Strip the app's own injected context so the classifier judges the user's words only. Mirrors the
 * routing heuristics in routing.ts: injected transcript / screen text is fenced with `"""`.
 */
function userText(raw: string): string {
  const head = raw.length > MAX_SCAN ? raw.slice(0, MAX_SCAN) : raw
  const fenced = head.replace(/"""[\s\S]*?"""/g, ' ')
  return fenced.replace(/\s+/g, ' ').trim().toLowerCase()
}

const RX = {
  translate: /\b(translate|traduis|traduire|übersetz|traduce|in (french|english|spanish|german|dutch|italian|portuguese)\b.*\b(say|write|put))/,
  summarize: /\b(summari[sz]e|summary|recap|tl;?dr|key points|main points|bullet points|condense|digest)\b/,
  draft: /\b(write|draft|compose|reply to|respond to|rewrite|reword|rephrase|polish|proofread|email|message|cover letter|linkedin post|follow[- ]?up)\b/,
  code: /(```|\bregex\b|\bsql\b|\bjson\b|\byaml\b|\bapi\b|\bfunction\b|\bclass\b|\bcompile|\bstack ?trace\b|\btypescript\b|\bjavascript\b|\bpython\b|\brust\b|\bswift\b|\bkotlin\b|\bbash\b|\bshell\b|\bgit\b|\bbug\b|\berror\b|\bexception\b|\bnull pointer\b|\bunit test\b|\balgorithm\b|\bbig[- ]o\b|\btime complexity\b)/,
  screen: /\b(on (my|the) screen|this screen|screenshot|what am i looking at|what does this (say|show|mean)|read this|this (page|window|slide|chart|graph|table|image|error|dialog))\b/,
  compare: /\b(compare|comparison|versus|vs\.?|difference between|differences? between|better than|pros and cons|trade[- ]?offs?|which (one|is better))\b/,
  estimate: /\b(how (much|many|long|big|far|often)|estimate|ballpark|calculate|compute|roughly|approximately|what would it cost|budget for|market size|sizing)\b/,
  decision: /\b(should (i|we)|do you recommend|recommend(ation)?|is it worth|worth it|best (option|choice|way|approach)|which should|what would you (do|choose|pick)|go with)\b/,
  behavioral: /\b(tell me about (yourself|a time)|walk me through your|why (do you want|this (company|role|job))|describe a (time|situation)|biggest (weakness|strength)|where do you see yourself|why should we hire|salary expectation|notice period)\b/,
  howto: /\b(how (do|can|could|would|should|to) (i|we|you|one)?|how to|steps? to|walk me through|set ?up|configure|install|guide|tutorial|what('s| is) the (best )?way to)\b/,
  explain: /\b(explain|why (is|are|does|do|did|would|can|isn'?t|aren'?t)|what does .{1,40} mean|meaning of|elaborate|clarify|in plain (english|words)|eli5|help me understand|what('s| is) the (reason|point|purpose|idea))\b/,
  factual: /^(who|what|when|where|which|is|are|was|were|does|do|did|has|have|can|could|will|would)\b|\b(who (is|was|are)|what (is|are|was|were)|when (is|was|did|does)|where (is|are|was)|define|definition of|capital of|founded|ceo of|population of|year did)\b/
}

/**
 * Classify one user prompt. Order matters: intent-carrying verbs (translate, summarize, draft) beat the
 * generic shape (a "what is" that asks for a translation is a translation). The screen bucket sits above
 * factual because "what is on my screen" is a screen ask, not a fact lookup. Vision asks are always
 * 'screen' regardless of wording: the input is an image, that is the type.
 */
export function classifyQuestionType(prompt: unknown, opts: { vision?: boolean } = {}): QuestionType {
  try {
    if (opts.vision) return 'screen'
    if (typeof prompt !== 'string') return 'unknown'
    const t = userText(prompt)
    if (!t) return 'unknown'
    if (RX.translate.test(t)) return 'translate'
    if (RX.summarize.test(t)) return 'summarize'
    if (RX.behavioral.test(t)) return 'behavioral'
    if (RX.screen.test(t)) return 'screen'
    if (RX.code.test(t)) return 'code'
    if (RX.draft.test(t)) return 'draft'
    if (RX.compare.test(t)) return 'compare'
    if (RX.estimate.test(t)) return 'estimate'
    if (RX.decision.test(t)) return 'decision'
    if (RX.howto.test(t)) return 'how-to'
    if (RX.explain.test(t)) return 'explain'
    if (RX.factual.test(t)) return 'factual'
    return 'other'
  } catch {
    // A regex engine fault on hostile input must never break an Ask or an ingest.
    return 'unknown'
  }
}

export interface QuestionTypeMix {
  /** Rows that carried a real classification (not 'unknown'). */
  classified: number
  /** All rows considered, including 'unknown' and rows from seats too old to send a type. */
  total: number
  /** classified / total, or null when total is 0. Never 0 when nothing was reported. */
  coverage: number | null
  /** Sorted descending by count; only types with count > 0. 'unknown' is excluded from the bars. */
  bars: { type: QuestionType; label: string; count: number }[]
}

/**
 * Aggregate stored types into a mix the console can show honestly. Legacy rows (no type at all) count in
 * `total` so coverage says "we only know the type of N% of Asks" instead of pretending 100%.
 */
export function aggregateQuestionTypes(types: (string | null | undefined)[]): QuestionTypeMix {
  const counts = new Map<QuestionType, number>()
  let classified = 0
  for (const raw of types) {
    const t = normalizeQuestionType(raw)
    if (t === 'unknown') continue
    classified++
    counts.set(t, (counts.get(t) ?? 0) + 1)
  }
  const total = types.length
  return {
    classified,
    total,
    coverage: total > 0 ? classified / total : null,
    bars: [...counts.entries()]
      .map(([type, count]) => ({ type, label: QUESTION_TYPE_LABELS[type], count }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
  }
}
