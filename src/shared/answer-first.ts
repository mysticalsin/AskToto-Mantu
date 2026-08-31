/**
 * answer-first.ts — every typed/screen answer leads with THE ANSWER.
 *
 * Two halves, both required:
 *   1. ANSWER_FIRST_RAIL, appended to the system prompt on answer/vision (see personas.ts).
 *   2. stripLeadingFiller / AnswerFirstFilter, applied to the streamed output so a model that
 *      ignores the rail still cannot open with "Sure" / "Let's" / a restatement of the question.
 *
 * Live suggest, recap, summary, and fact-check keep their own contracts and do not use this rail
 * or this filter. Pure module: no I/O, safe to unit-test.
 */

/** Appended after GROUNDING_RAIL on typed and screen asks. No em dash. */
export const ANSWER_FIRST_RAIL = `

ANSWER FIRST:
- The first sentence is the answer. A number, a name, a yes or no, the next line to say.
- Never open with Sure, Of course, Certainly, Absolutely, Great question, Happy to, Let me, or Let's.
- Never restate the question. Do not write "you asked" or "regarding your question".
- No greeting and no sign-off. Stop when the question is answered.`

/**
 * Leading filler the post-filter strips. Each alternative is a complete opener, not a word that
 * can legally start an answer ("Absolute zero", "Certainly possible" as a product name are rare;
 * we only strip when the token is a standalone politeness clause).
 */
const FILLER_OPENER =
  /^(?:sure(?: thing)?|of course|certainly|absolutely|great question|that's a great question|that is a great question|happy to help|i'd be happy to|i would be happy to|let me [^.!\n]+|let's [^.!\n]+|here(?:'s| is)(?: the answer)?|the answer is|you asked|regarding your question|as requested)(?:[.!]|[,:])?\s*/i

const FILLER_LINE = /^(?:sure(?: thing)?|of course|certainly|absolutely|great question)[.!]?\s*$/i

/** Count words the same way the time-saved note-taking heuristic does (whitespace split). */
export function wordCount(text: string): number {
  const parts = text.trim().split(/\s+/).filter(Boolean)
  return parts.length
}

/**
 * Strip one or more leading filler clauses. Idempotent. Leaves the rest of the text untouched,
 * including a later "sure" that is part of the answer.
 */
export function stripLeadingFiller(text: string, question?: string): string {
  if (!text) return text
  let out = text
  // Drop a leading BOM / zero-width that some local models emit before the first word.
  out = out.replace(/^[\uFEFF\u200B\u200C\u200D]+/, '')
  for (let i = 0; i < 4; i++) {
    const next = out.replace(FILLER_OPENER, '')
    if (next === out) break
    out = next
  }
  out = out.replace(/^(?:\n\s*)+/, '')
  if (question && question.trim()) {
    out = stripRestatedQuestion(out, question)
  }
  return out
}

/**
 * If the model echoed the question as its first sentence, drop that sentence.
 * Comparison is case-insensitive and ignores trailing punctuation.
 */
export function stripRestatedQuestion(text: string, question: string): string {
  const q = normalizeForEcho(question)
  if (q.length < 8) return text
  const match = text.match(/^([^.!?\n]+)[.!?]?\s*/)
  if (!match) return text
  const first = normalizeForEcho(match[1])
  if (!first) return text
  if (first === q || q.includes(first) || first.includes(q)) {
    return text.slice(match[0].length)
  }
  return text
}

function normalizeForEcho(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Streaming wrapper: hold the leading bytes until we can decide they are (or are not) filler,
 * then pass the rest through. A model that answers "68" in one token is flushed immediately.
 */
export class AnswerFirstFilter {
  private buffer = ''
  private released = false
  private readonly question?: string

  constructor(question?: string) {
    this.question = question
  }

  push(delta: string): string {
    if (!delta) return ''
    if (this.released) return delta
    this.buffer += delta
    // Need a word boundary or punctuation before we can judge an opener.
    const ready = /[\n.!?]|.{24}/.test(this.buffer) || this.buffer.length >= 48
    if (!ready) return ''
    return this.flush()
  }

  flush(): string {
    if (this.released) {
      const rest = this.buffer
      this.buffer = ''
      return rest
    }
    const cleaned = stripLeadingFiller(this.buffer, this.question)
    this.buffer = ''
    this.released = true
    // A buffer that was only filler becomes empty; that is correct.
    if (FILLER_LINE.test(cleaned.trim())) return ''
    return cleaned
  }
}
