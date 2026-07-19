import type { ModelTier } from './providers'

/**
 * Thinking-mode policy (per Tony) — three speed/quality tiers:
 *  - 'auto'   → smart routing: basic questions go to BASE (Haiku, fastest); heavier analytical
 *               questions go to THINK (Sonnet); coding / deep reasoning goes to DEEP (Opus).
 *  - 'always' → every answer uses the DEEP model (Opus — maximum depth).
 *  - 'never'  → every answer uses the BASE model (Haiku — fastest/cheapest).
 * Live suggestions ('suggest') always use BASE regardless of mode — they must be real-time.
 */
export type ThinkingMode = 'auto' | 'always' | 'never'

/** Ask modes the router cares about (AskMode: 'answer' is the normal chat turn). */
export type RoutableMode = 'answer' | 'vision' | 'suggest' | 'summary' | 'recap' | string

// The renderer's own prompt-builders (withContext/buildWhatNextPrompt/buildExplainPrompt/
// buildSpotlightRefPrompt in shared/quick-actions.ts + App.tsx) all wrap INJECTED grounding material —
// the live meeting transcript or on-screen text, up to ~3000 chars — in a `"""..."""` fence. That
// convention is specific to this app (a bare human question essentially never contains literal `"""`),
// so stripping it before measuring length lets the length heuristic judge the user's own question
// instead of whatever context was bolted on for grounding.
const stripInjectedContext = (t: string): string => t.replace(/"""[\s\S]*?"""/g, ' ').trim()

/**
 * Heuristic: is this a DEEP question — coding / engineering / formal math / explicit "think deeply"?
 * These go to the deepest model (Opus). Deterministic and zero-latency — no extra model call.
 * Intentionally conservative toward escalating coding/eng work.
 */
export function isHardQuestion(text: string): boolean {
  const t = (text || '').trim()
  if (!t) return false
  // Strip injected context ONCE, up front, and judge every check below — fenced-code, length,
  // technical/math regexes, "think harder" cues — against the user's own question only (see
  // stripInjectedContext above). Else an injected transcript/screen-context block riding along with an
  // ordinary quick action can itself contain backticks, jargon, or "walk me through" phrasing and get a
  // trivial question silently forced to the deep/Opus tier regardless of how simple it actually is.
  const stripped = stripInjectedContext(t)
  // Any fenced code block, or a long multi-part prompt → treat as complex.
  if (/```/.test(stripped)) return true
  // Length alone escalates to the expensive deep/Opus tier.
  if (stripped.length > 600) return true

  const lower = stripped.toLowerCase()
  // Engineering / coding / technical-depth signals.
  const technical =
    /\b(code|coding|program(?:ming)?|function|method|class\b|algorithm|complexity|big-?o|refactor|debug(?:ging)?|stack ?trace|exception|compiler?|build error|architecture|design pattern|data ?structure|regex|sql|query|schema|database|index(?:ing)?|api\b|endpoint|typescript|javascript|python|java\b|kotlin|swift|rust|golang|c\+\+|c#|ruby|php|kubernetes|docker|terraform|ci\/cd|deploy(?:ment)?|infra(?:structure)?|concurren\w+|async|thread(?:ing)?|race condition|memory leak|optimi[sz]e|performance|latency|throughput|benchmark|cryptograph|webpack|compile|runtime error|null pointer|segfault)\b/
  if (technical.test(lower)) return true

  // Math / formal-reasoning signals.
  if (/\b(prove|theorem|proof|derivative|integral|calculus|matrix|eigen|equation|optimi[sz]ation problem|np-hard|combinatori)\w*/.test(lower)) {
    return true
  }

  // Explicit "think harder" cues from the user.
  if (/\b(think (?:hard|harder|deeply|step)|step[ -]?by[ -]?step|reason through|walk me through|analy[sz]e (?:deeply|in depth)|in depth|thoroughly|rigorous)\b/.test(lower)) {
    return true
  }

  return false
}

/**
 * Heuristic: is this a HEAVIER (mid-tier) question — analytical/substantive but not deep-technical?
 * These go to the THINK model (Sonnet): the middle ground between a one-liner and a coding deep-dive.
 * Only consulted when the prompt is NOT already a deep question.
 */
export function isHeavyQuestion(text: string): boolean {
  const t = (text || '').trim()
  if (!t) return false
  // Strip injected context first (mirrors isHardQuestion above) — the length, analytical-verb, and
  // sentence-count checks below must judge the user's own question, not an injected transcript/
  // screen-context block (e.g. withContext's ~214-char boilerplate + a long meeting transcript) riding
  // along with it. Otherwise even a trivial question sent with grounding context exceeds every threshold.
  const stripped = stripInjectedContext(t)
  if (stripped.length > 220) return true // a long-ish prose question deserves more than the fast model
  const lower = stripped.toLowerCase()
  // Analytical / open-ended verbs that signal real reasoning or drafting work (non-technical).
  const analytical =
    /\b(explain|compare|comparison|contrast|why\b|how (?:do|does|can|should|would|might)|summari[sz]e|draft|write|compose|rewrite|outline|plan\b|strategy|strategi[sz]e|recommend|suggest|evaluate|assess|review|critique|brainstorm|pros and cons|trade-?offs?|differen(?:ce|ces|tiate)|implication|should i\b|what'?s the best|best way|help me (?:write|plan|think|decide|figure)|weigh)\b/
  if (analytical.test(lower)) return true
  // Multi-sentence and not trivially short → likely a layered ask.
  const sentences = (stripped.match(/[.!?]+/g) || []).length
  if (sentences >= 2 && stripped.length > 80) return true
  return false
}

/**
 * Pick the model tier for a request given the user's thinking-mode policy.
 * The user-facing prompt for chat/vision modes is in `prompt`.
 *  auto → base (Haiku) for basic, think (Sonnet) for heavier, deep (Opus) for coding/deep reasoning.
 */
export function routeTier(
  req: { mode: RoutableMode; prompt?: string; transcript?: string; kind?: string },
  mode: ThinkingMode
): ModelTier {
  // Live suggestions must be instant — never escalate.
  if (req.mode === 'suggest') return 'base'
  // Fact-checks need a STRONG model, not the strongest+slowest: 'deep' meant 10-15s to a verdict on the
  // Dust deep agent (and interactive Opus on Anthropic). Think-tier (Sonnet-class) verdicts are just as
  // reliable for claim-checking and land in a fraction of the time — users fact-check LIVE, mid-call.
  if (req.kind === 'factcheck') return mode === 'never' ? 'base' : 'think'
  if (mode === 'never') return 'base'
  if (mode === 'always') return 'deep' // explicit deep mode → the strongest model

  // auto:
  if (req.mode === 'recap') return 'think' // the post-meeting document — Sonnet's depth is plenty
  if (req.mode === 'summary') return 'base' // quick recap of a transcript — base is fine
  // chat / vision → 3-way escalation by difficulty.
  const prompt = req.prompt || ''
  if (isHardQuestion(prompt)) return 'deep'
  if (isHeavyQuestion(prompt)) return 'think'
  return 'base'
}
