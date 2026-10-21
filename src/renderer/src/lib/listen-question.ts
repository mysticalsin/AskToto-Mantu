const QWORDS =
  /^(what|why|how|when|where|who|which|can|could|would|do|does|did|are|is|have|has|tell me|walk me|describe|explain|give me)\b/i
// Words a complete question never ends on: articles, coordinating conjunctions, possessive determiners.
// A line that dangles on one of these (e.g. "what is the…") is a question cut mid-sentence by a VAD endpoint,
// not a finished one — so we hold off firing the auto-answer and let the coalesced turn accumulate the rest.
// (Stranded prepositions like "where are you from" are deliberately NOT here — they DO end real questions.)
const DANGLING = /\b(the|a|an|and|or|but|your|my|our|their|its)$/i
// Terminal question-mark variants beyond ASCII '?' (U+003F): fullwidth '？' (U+FF1F, CJK) and Arabic '؟'
// (U+061F) — Whisper transcribes many languages with these, so relying on endsWith('?') alone silently
// dropped every non-English question from proactive auto-suggest.
const TERMINAL_Q = /[?？؟]$/
// QWORDS is a hard-coded English word list — only meaningful for space-delimited Latin-script clauses.
// Gate the word-count/QWORDS branch on that so it can't misfire on non-Latin text (CJK/Arabic/Cyrillic,
// which QWORDS wouldn't match anyway and which TERMINAL_Q already handles). Cover the full Latin range,
// NOT just ASCII: Whisper/entity-casing emit a curly apostrophe (U+2019 in "What's"/"don't"/"L'Oréal")
// and accented letters (café, naïve) — a pure-ASCII gate silently dropped every such English question.
const LATIN_CLAUSE = /^[\x00-ɏ‘’“”–—…]*$/
export function isQuestion(t: string): boolean {
  const s = t.trim()
  if (!s) return false
  if (TERMINAL_Q.test(s)) return true // explicit terminal punctuation → complete even when short
  // Evaluate only the run's last clause: an accumulated/long turn may carry a completed leading sentence
  // (e.g. "So we shipped the update. What should we prioritize") -- QWORDS must match that clause's opening
  // word, not the whole run's, or a finished non-question opener permanently blocks every later question
  // in the same 'them' turn.
  const lastClause = s.split(/(?<=[.!?？؟])\s+/).pop() ?? s
  if (DANGLING.test(lastClause.replace(/[.,;:!?？؟\s]+$/, ''))) return false // still mid-sentence → not yet a question
  return LATIN_CLAUSE.test(lastClause) && lastClause.split(/\s+/).length >= 3 && QWORDS.test(lastClause)
}
