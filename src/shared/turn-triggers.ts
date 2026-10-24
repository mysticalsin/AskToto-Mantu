// Cheap, stateless question/objection trigger for a coalesced "them" turn in EN, FR, PT-BR and ES (G72).
// Regex-only: O(n) over at most TRIGGER_MAX_CHARS, no model, no I/O. The result carries enum ids only, never
// transcript text. The caller (listen.ts) owns coalescing and fire-once semantics.
import { detectLanguage } from './lang-id'
import {
  LEAD_MARKERS,
  LEXICON,
  OBJECTION_CUES,
  TRIGGER_LANGS,
  type ObjectionCue,
  type TriggerLang
} from './turn-trigger-lexicon'

export { TRIGGER_LANGS, type TriggerLang } from './turn-trigger-lexicon'

export type TriggerKind = 'question' | 'objection'
export type TriggerCue = 'terminal-mark' | 'inverted-mark' | 'q-opener' | 'tag-question' | ObjectionCue

export interface TurnTrigger {
  readonly kind: TriggerKind
  readonly lang: TriggerLang | null
  readonly cue: TriggerCue
}

export const TRIGGER_MAX_CHARS = 600

// Terminal question-mark variants beyond ASCII '?': fullwidth '？' (CJK) and Arabic '؟'.
const TERMINAL_Q = /[?？؟]$/
// Space-delimited Latin-script clauses only (full Latin range incl. curly quotes and accents).
const LATIN_CLAUSE = /^[\x00-ɏ‘’“”–—…]*$/
const MIN_QUESTION_WORDS = 3

/** Accent-stripped, lowercase, straight apostrophes, collapsed whitespace. */
export function normalizeTurn(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim()
}

const WORD_EDGE = '(?![\\p{L}\\p{N}])'

function altSource(src: string, tail: boolean): string {
  const body = src.replace(/ /g, '\\s+')
  return tail && !src.endsWith("'") ? body + WORD_EDGE : body
}

/** Compile one lexicon entry; `anchored` pins it to the clause start, otherwise it is a word-bounded search. */
export function phraseRegex(src: string, anchored: boolean): RegExp {
  const body = altSource(src, true)
  return new RegExp(anchored ? '^(?:' + body + ')' : '(?<![\\p{L}\\p{N}])(?:' + body + ')', 'u')
}

function listRegex(srcs: readonly string[], anchored: boolean): RegExp | null {
  if (srcs.length === 0) return null
  const sorted = [...srcs].sort((a, b) => b.length - a.length)
  const body = sorted.map((s) => altSource(s, true)).join('|')
  return new RegExp(anchored ? '^(?:' + body + ')' : '(?<![\\p{L}\\p{N}])(?:' + body + ')', 'u')
}

interface Compiled {
  openers: RegExp | null
  notOpeners: RegExp | null
  tags: RegExp | null
  objections: ReadonlyArray<readonly [ObjectionCue, RegExp]>
}

function compile(lang: TriggerLang): Compiled {
  const lex = LEXICON[lang]
  const tagBody = lex.tags.map((t) => altSource(t, false)).join('|')
  return {
    openers: listRegex(lex.openers, true),
    notOpeners: listRegex(lex.notOpeners, true),
    tags: tagBody ? new RegExp(',\\s*(?:' + tagBody + ')$', 'u') : null,
    objections: OBJECTION_CUES.map((cue) => [cue, listRegex(lex.objections[cue], false)!] as const)
  }
}

const COMPILED: Record<TriggerLang, Compiled> = {
  en: compile('en'),
  fr: compile('fr'),
  'pt-BR': compile('pt-BR'),
  es: compile('es')
}

const LEAD_RE = new RegExp('^(?:' + LEAD_MARKERS.join('|') + ')[,\\s]+', 'u')
const DANGLING_ALL: ReadonlySet<string> = new Set(TRIGGER_LANGS.flatMap((l) => LEXICON[l].dangling))

const DETECTED: Record<string, TriggerLang> = { English: 'en', French: 'fr', Portuguese: 'pt-BR', Spanish: 'es' }

function detectedLang(clause: string): TriggerLang | null {
  const lang = detectLanguage(clause).lang
  return (lang && DETECTED[lang]) || null
}

function stripLead(c: string): string {
  let out = c
  for (let i = 0; i < 2; i++) {
    const m = LEAD_RE.exec(out)
    if (!m) break
    out = out.slice(m[0].length)
  }
  return out
}

export function classifyTurn(text: string): TurnTrigger | null {
  const s = text.trim().slice(-TRIGGER_MAX_CHARS).trim()
  if (!s) return null
  // Evaluate only the run's last clause: an accumulated turn may carry finished leading sentences.
  const lastClause = s.split(/(?<=[.!?？؟])\s+/).pop() ?? s
  if (TERMINAL_Q.test(s)) return { kind: 'question', lang: detectedLang(lastClause), cue: 'terminal-mark' }
  if (!LATIN_CLAUSE.test(lastClause)) return null
  // Dangling on a function word = a question cut mid-sentence by a VAD endpoint. Accents are kept here so
  // PT "é" (is) is not mistaken for "e" (and) and FR "où" is not "ou".
  const lastWord = /[\p{L}\p{N}'-]+$/u.exec(
    lastClause
      .toLowerCase()
      .replace(/’/g, "'")
      .replace(/[.,;:!?？؟\s]+$/, '')
  )
  if (lastWord && DANGLING_ALL.has(lastWord[0])) return null

  const clause = stripLead(normalizeTurn(lastClause))
  if (!clause) return null
  const words = clause.split(' ').length

  if (clause.startsWith('¿')) {
    if (words >= 2) return { kind: 'question', lang: detectedLang(lastClause), cue: 'inverted-mark' }
  } else if (words >= MIN_QUESTION_WORDS) {
    const hits = TRIGGER_LANGS.filter((l) => {
      const c = COMPILED[l]
      return c.openers?.test(clause) === true
    })
    const blocked = TRIGGER_LANGS.some((l) => COMPILED[l].notOpeners?.test(clause) === true)
    if (hits.length > 0 && !blocked) {
      const guess = detectedLang(lastClause)
      return { kind: 'question', lang: guess && hits.includes(guess) ? guess : hits[0]!, cue: 'q-opener' }
    }
  }
  const plain = clause.replace(/[.!?\s]+$/, '')
  if (words >= MIN_QUESTION_WORDS) {
    for (const l of TRIGGER_LANGS) {
      if (COMPILED[l].tags?.test(plain)) return { kind: 'question', lang: l, cue: 'tag-question' }
    }
  }
  for (const l of TRIGGER_LANGS) {
    for (const [cue, re] of COMPILED[l].objections) {
      if (re.test(clause)) return { kind: 'objection', lang: l, cue }
    }
  }
  return null
}
