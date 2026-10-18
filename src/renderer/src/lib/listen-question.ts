const QWORDS =
  /^(what|why|how|when|where|who|which|can|could|would|do|does|did|are|is|have|has|tell me|walk me|describe|explain|give me)\b/i
// Clear question openers used in French, Brazilian Portuguese, and Spanish. Keep these separate from the
// existing English list so this addition does not broaden English turn classification.
const MULTILINGUAL_QWORDS =
  /^(?:pourquoi|comment|quand|où|qui|que|quoi|quel(?:le|s|les)?|qu['’]est-ce (?:que|qui)|qu['’]est-ce qu['’](?:il|elle|on|ils|elles)|est-ce que|peux-tu|pouvez-vous|pourrais-tu|pourriez-vous|qué|por qué|cómo|cuándo|dónde|adónde|quién(?:es)?|cuál(?:es)?|cuánto(?:s|a|as)?|o que|por que|como|quando|onde|aonde|quem|qual(?:is)?|quais|quanto(?:s|a|as)?)(?=$|[\s,;:])/i
// Words a complete question never ends on: articles, coordinating conjunctions, possessive determiners.
// A line that dangles on one of these (e.g. "what is the…") is a question cut mid-sentence by a VAD endpoint,
// not a finished one — so we hold off firing the auto-answer and let the coalesced turn accumulate the rest.
// (Stranded prepositions like "where are you from" are deliberately NOT here — they DO end real questions.)
const DANGLING = /\b(the|a|an|and|or|but|your|my|our|their|its)$/i
// These common French, Portuguese, and Spanish function words indicate that an unpunctuated ASR window
// stopped before its predicate or object. Keep this guard separate so the English list stays unchanged.
const MULTILINGUAL_DANGLING =
  /(?:^|\s)(?:le|la|les|un|une|des|du|et|ou|mais|mon|ma|mes|ton|ta|tes|son|sa|ses|notre|nos|votre|vos|leur|leurs|ce|cet|cette|ces|el|la|los|las|un|una|unos|unas|lo|y|o|pero|mi|mis|tu|tus|su|sus|nuestro|nuestra|nuestros|nuestras|este|estos|estas|um|uma|uns|umas|os|as|a|do|da|dos|das|na|nos|nas|seu|sua|seus|suas|meu|minha|meus|minhas|nosso|nossa|nossos|nossas|e|mas|que)$/i
// A bare subject after these constructions is incomplete; do not treat every pronoun as dangling because
// complete questions may naturally end with a pronoun ("Qué quieres tú") or a finite verb.
const FRENCH_INCOMPLETE_SUBJECT =
  /^(?:(?:pourquoi|comment|quand|où|qui|que|quoi|quel(?:le|s|les)?)\s+est-ce que|qu['’]est-ce (?:que|qui)|est-ce que)\s+(?:je|tu|il|elle|on|nous|vous|ils|elles)$/i
const FRENCH_INCOMPLETE_CLITIC = /^qu['’]est-ce qui se$/i
const FRENCH_INCOMPLETE_PROGRESSIVE =
  /^qu['’]est-ce (?:que (?:je suis|tu es|nous sommes|vous êtes)|qu['’](?:il|elle|on) est|qu['’](?:ils|elles) sont) en train de$/i
const SPANISH_INCOMPLETE_CLITIC =
  /^(?:por qué|qué|cómo|cuándo|dónde|quién(?:es)?|cuál(?:es)?|cuánto(?:s|a|as)?)\s+se(?:\s+ha)?$/i
const SPANISH_INCOMPLETE_DEMONSTRATIVE = /^qué es esta$/i
const PORTUGUESE_INCOMPLETE_TAIL =
  /^(?:o que\s+(?:é|eu|você|vocês|ele|ela|nós|eles|elas|está)|(?:o que|por que|como|quando|onde|aonde|quem|qual(?:is)?|quais|quanto(?:s|a|as)?)\b.*\s+(?:no|com))$/i
const MULTILINGUAL_COMPLETE_POSSESSIVE =
  /^(?:(?:qual|quais)\s+(?:é|são)\s+(?:(?:o|a|os|as)\s+)?(?:seu|sua|seus|suas|meu|minha|meus|minhas|nosso|nossa|nossos|nossas|vosso|vossa|vossos|vossas|teu|tua|teus|tuas|dele|dela|deles|delas)|(?:qué|cuál(?:es)?)\s+(?:es|son)\s+(?:(?:el|la|los|las)\s+)?(?:nuestro|nuestra|nuestros|nuestras|vuestro|vuestra|vuestros|vuestras|mío|mía|míos|mías|tuyo|tuya|tuyos|tuyas|suyo|suya|suyos|suyas)|quel(?:le|s|les)?\s+(?:est|sont)\s+(?:le|la|les)\s+(?:mien|mienne|miens|miennes|tien|tienne|tiens|tiennes|sien|sienne|siens|siennes|notre|nôtre|nôtres|vôtre|vôtres|leur|leurs))$/i
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
  const s = t.normalize('NFC').trim().replace(/\s+/g, ' ')
  if (!s) return false
  if (TERMINAL_Q.test(s)) return true // explicit terminal punctuation → complete even when short
  // Evaluate only the run's last clause: an accumulated/long turn may carry a completed leading sentence
  // (e.g. "So we shipped the update. What should we prioritize") -- QWORDS must match that clause's opening
  // word, not the whole run's, or a finished non-question opener permanently blocks every later question
  // in the same 'them' turn.
  const lastClause = s.split(/(?<=[.!?？؟])\s+/).pop() ?? s
  const clause = lastClause.replace(/^[¿¡\s]+/, '')
  const completedText = clause.replace(/[.,;:!?？؟\s]+$/, '')
  if (DANGLING.test(completedText)) return false // still mid-sentence → not yet a question
  if (!LATIN_CLAUSE.test(lastClause) || clause.split(/\s+/).length < 3) return false
  if (QWORDS.test(lastClause)) return true
  if (!MULTILINGUAL_QWORDS.test(clause)) return false
  const isCompletePossessiveAnswer = MULTILINGUAL_COMPLETE_POSSESSIVE.test(completedText)
  if (
    (MULTILINGUAL_DANGLING.test(completedText) && !isCompletePossessiveAnswer) ||
    FRENCH_INCOMPLETE_SUBJECT.test(completedText) ||
    FRENCH_INCOMPLETE_CLITIC.test(completedText) ||
    FRENCH_INCOMPLETE_PROGRESSIVE.test(completedText) ||
    SPANISH_INCOMPLETE_CLITIC.test(completedText) ||
    SPANISH_INCOMPLETE_DEMONSTRATIVE.test(completedText) ||
    PORTUGUESE_INCOMPLETE_TAIL.test(completedText)
  ) {
    return false
  }
  // French and Portuguese temporal subclauses followed by a main clause are statements, not questions.
  const temporalContinuation = /^(?:quand|quando)\s+[^,]+,\s*(.+)$/i.exec(clause)?.[1]
  const temporalOpener = /^(?:quand|quando)\s+([^,]+),/i.exec(clause)?.[1] ?? ''
  const temporalInversion = /\b\p{L}+(?:-t)?-(?:je|tu|il|elle|on|nous|vous|ils|elles)\b/iu.test(temporalOpener)
  if (
    temporalContinuation &&
    !temporalInversion &&
    /^(?:(?:je|tu|il|elle|on|nous|vous|ils|elles|eu)\s+\p{L}+|(?:le|la|les|un|une|des|ce|cette|ces|o|a|os|as|um|uma|uns|umas)\s+\p{L}+\s+\p{L}+)/iu.test(
      temporalContinuation
    )
  ) {
    return false
  }
  // Portuguese "como <role>, (eu) ..." and its no-comma transcript form are statements.
  const roleIntro =
    /^como\s+(?:gerente|líder|diretor(?:a)?|administrador(?:a)?|desenvolvedor(?:a)?|gestor(?:a)?|usuário|usuária|professor(?:a)?|consultor(?:a)?)\b/iu.exec(
      clause
    )
  if (roleIntro) {
    const continuation = clause.slice(roleIntro[0].length).trim().replace(/^,\s*/, '')
    const withoutSubject = continuation.replace(/^eu\s+/i, '')
    if (/^(?:devo|posso|quero|preciso|vou|tenho)\b/i.test(withoutSubject)) return true
    if (withoutSubject) return false
  }
  return true
}
