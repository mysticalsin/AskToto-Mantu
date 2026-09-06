/**
 * Ask-side caveman register: intensity, slash/off commands, Auto-Clarity.
 * Persistence lives in settings.askCaveman (the existing settings store).
 * Not an Operator skill pack and not a tenth conversation mode.
 */

export const ASK_CAVEMAN_LEVELS = [
  'off',
  'lite',
  'full',
  'ultra',
  'wenyan-lite',
  'wenyan-full',
  'wenyan-ultra'
] as const

export type AskCavemanLevel = (typeof ASK_CAVEMAN_LEVELS)[number]

export const DEFAULT_ASK_CAVEMAN: AskCavemanLevel = 'full'

export function isAskCavemanLevel(value: unknown): value is AskCavemanLevel {
  return typeof value === 'string' && (ASK_CAVEMAN_LEVELS as readonly string[]).includes(value)
}

const LEVEL_ALT = 'off|lite|full|ultra|wenyan-lite|wenyan-full|wenyan-ultra|wenyan'
const SLASH_RE = new RegExp(`^\\s*/caveman(?:\\s+(${LEVEL_ALT}))?\\s*`, 'i')
const STOP_RE = /^\s*stop\s+caveman(?:\s*[.!?]+)?\s*/i
const NORMAL_EXACT_RE = /^\s*normal\s+mode\s*[.!?]*\s*$/i
const NORMAL_PREFIX_RE = /^\s*normal\s+mode\s*[.!?]+\s+/i

export interface ParsedCavemanAsk {
  /** Question after the command is stripped. Empty means command-only. */
  visiblePrompt: string
  /** Next persisted register, or null when the prompt did not switch modes. */
  next: AskCavemanLevel | null
}

function normalizeLevel(raw: string): AskCavemanLevel {
  const level = raw.toLowerCase()
  if (level === 'wenyan') return 'wenyan-full'
  return level as AskCavemanLevel
}

/**
 * Parse a typed Ask prompt for `/caveman …`, "stop caveman", or "normal mode".
 * Leading command only — mid-sentence "what is normal mode in vim" does not switch.
 */
export function parseCavemanAskPrompt(raw: string): ParsedCavemanAsk {
  const text = raw ?? ''
  const slash = SLASH_RE.exec(text)
  if (slash) {
    const next = normalizeLevel(slash[1] || 'full')
    return { visiblePrompt: text.slice(slash[0].length).trim(), next }
  }
  const stop = STOP_RE.exec(text)
  if (stop) {
    return { visiblePrompt: text.slice(stop[0].length).trim(), next: 'off' }
  }
  if (NORMAL_EXACT_RE.test(text)) {
    return { visiblePrompt: '', next: 'off' }
  }
  const normal = NORMAL_PREFIX_RE.exec(text)
  if (normal) {
    return { visiblePrompt: text.slice(normal[0].length).trim(), next: 'off' }
  }
  return { visiblePrompt: text, next: null }
}

const CLARIFY_RE =
  /\b(clarif(?:y|ied|ies|ication)|what do you mean|say that again|in plain (?:english|language)|i don'?t understand|repeat (?:that|the question)|can you explain(?: that)? again)\b/i

const IRREVERSIBLE_RE =
  /\b(permanently delete|cannot be undone|irreversible|drop table|rm -rf|wipe (?:all|the|disk)|format (?:the )?disk|destructive|security warning|are you sure|please confirm)\b/i

const MULTISTEP_AMBIGUITY_RE =
  /\b(migrate table drop column backup first|then (?:delete|drop|remove) after|multi-?step|step by step)\b/i

/**
 * Auto-Clarity: drop caveman for the warning/confirm/clarify part of this turn.
 * Resume after the clear part. Model-judged cases still live in the skill body;
 * this helper pins the cases we can see from the typed question.
 */
export function autoClarityDropCaveman(prompt: string): boolean {
  const text = (prompt || '').trim()
  if (!text) return false
  return CLARIFY_RE.test(text) || IRREVERSIBLE_RE.test(text) || MULTISTEP_AMBIGUITY_RE.test(text)
}

export const AUTO_CLARITY_DIRECTIVE =
  '\n\nAUTO-CLARITY: this turn needs clear English for the warning, confirm, multi-step, or clarify part. Drop caveman for that part. Resume caveman after the clear part is done.'
