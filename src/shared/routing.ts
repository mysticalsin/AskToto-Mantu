import type { ModelTier } from './providers'

/**
 * Thinking-mode policy (per Tony):
 *  - 'auto'   → smart routing: simple questions go to the fast/cheap BASE model (e.g. Haiku);
 *               coding / engineering / complex questions are pushed to the THINK model (e.g. Sonnet).
 *  - 'always' → every answer uses the THINK model (deep mode).
 *  - 'never'  → every answer uses the BASE model (fast/cheap mode).
 * Live suggestions ('suggest') always use BASE regardless of mode — they must be real-time.
 */
export type ThinkingMode = 'auto' | 'always' | 'never'

/** Ask modes the router cares about (AskMode: 'answer' is the normal chat turn). */
export type RoutableMode = 'answer' | 'vision' | 'suggest' | 'summary' | 'recap' | string

/**
 * Heuristic: is this a hard question that deserves the stronger (thinking) model?
 * Deterministic and zero-latency — no extra model call. Catches code, engineering, math, and
 * explicit "think deeply" cues. Intentionally conservative toward escalating coding/eng work.
 */
export function isHardQuestion(text: string): boolean {
  const t = (text || '').trim()
  if (!t) return false
  // Any fenced code block, or a long multi-part prompt → treat as complex.
  if (/```/.test(t)) return true
  if (t.length > 600) return true

  const lower = t.toLowerCase()
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
 * Pick the model tier for a request given the user's thinking-mode policy.
 * The user-facing prompt for chat/vision modes is in `prompt`.
 */
export function routeTier(
  req: { mode: RoutableMode; prompt?: string; transcript?: string },
  mode: ThinkingMode
): ModelTier {
  // Live suggestions must be instant — never escalate.
  if (req.mode === 'suggest') return 'base'
  if (mode === 'never') return 'base'
  if (mode === 'always') return 'think'

  // auto:
  if (req.mode === 'recap') return 'think' // the detailed post-meeting document benefits from depth
  if (req.mode === 'summary') return 'base' // quick recap of a transcript — base is fine
  // chat / vision → escalate only when the prompt looks hard.
  return isHardQuestion(req.prompt || '') ? 'think' : 'base'
}
