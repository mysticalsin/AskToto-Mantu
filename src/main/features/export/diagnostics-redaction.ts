/**
 * diagnostics-redaction.ts — the gate every diagnostics file passes before the owner previews or exports it.
 *
 * Reuses the Q01 secret redaction (`redactSecrets`: keys, tokens, JWTs, cards, SSNs, private keys) and adds the
 * rules a log trail needs that a cloud prompt does not: email addresses, the OS account name inside home paths,
 * credentials inside URLs, and any JSON field that carries meeting content (transcripts, questions, answers,
 * notes). Fail-closed on content keys: the value is dropped by key name, whatever it contains.
 *
 * Pure: no filesystem, no clock. The counts say how many values were replaced, never what they were.
 */
import { redactSecrets } from '@shared/redact'

export type RedactionCategory = 'secret' | 'email' | 'home-path' | 'url-credential' | 'content-field'

export type RedactionCounts = Record<RedactionCategory, number>

export interface RedactedText {
  text: string
  counts: RedactionCounts
  total: number
}

/** JSON keys whose values are meeting or user content. Matched case-insensitively on the whole key. */
const CONTENT_KEYS = new Set([
  'transcript',
  'text',
  'content',
  'utterance',
  'utterances',
  'question',
  'answer',
  'prompt',
  'response',
  'summary',
  'notes',
  'note',
  'body',
  'message',
  'title',
  'snippet',
  'excerpt',
  'caption',
  'speaker',
  'attendees',
  'participants',
  'email',
  'subject'
])

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
const POSIX_HOME_RE = /(\/(?:Users|home)\/)[^/\s"'\\]+/g
const WIN_HOME_RE = /([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s"']+/gi
const URL_CRED_RE = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@"']+@/gi
const URL_QUERY_RE = /(\bhttps?:\/\/[^\s"'?#]+)\?[^\s"'#]*/gi
const MARKER_RE = /\[redacted[^\]]*\]/g

export function zeroRedactionCounts(): RedactionCounts {
  return { secret: 0, email: 0, 'home-path': 0, 'url-credential': 0, 'content-field': 0 }
}

export function addRedactionCounts(into: RedactionCounts, from: RedactionCounts): void {
  for (const key of Object.keys(into) as RedactionCategory[]) into[key] += from[key]
}

function sum(counts: RedactionCounts): number {
  return Object.values(counts).reduce((a, b) => a + b, 0)
}

function scrubString(input: string, counts: RedactionCounts): string {
  let text = input
  const markersBefore = (text.match(MARKER_RE) ?? []).length
  text = redactSecrets(text)
  counts.secret += Math.max(0, (text.match(MARKER_RE) ?? []).length - markersBefore)
  text = text.replace(URL_CRED_RE, (_m, scheme: string) => {
    counts['url-credential'] += 1
    return `${scheme}[redacted]@`
  })
  // A query string is where tokens and ids travel; the path is kept so the endpoint stays diagnosable.
  text = text.replace(URL_QUERY_RE, (_m, base: string) => {
    counts['url-credential'] += 1
    return `${base}?[redacted]`
  })
  text = text.replace(EMAIL_RE, () => {
    counts.email += 1
    return '[redacted email]'
  })
  text = text.replace(POSIX_HOME_RE, (_m, prefix: string) => {
    counts['home-path'] += 1
    return `${prefix}[user]`
  })
  text = text.replace(WIN_HOME_RE, (_m, prefix: string) => {
    counts['home-path'] += 1
    return `${prefix}[user]`
  })
  return text
}

function scrubValue(value: unknown, counts: RedactionCounts): unknown {
  if (typeof value === 'string') return scrubString(value, counts)
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, counts))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const isContent = CONTENT_KEYS.has(key.toLowerCase())
      if (isContent && v !== null && v !== '' && typeof v !== 'boolean' && typeof v !== 'number') {
        counts['content-field'] += 1
        out[key] = '[redacted content]'
      } else {
        out[key] = scrubValue(v, counts)
      }
    }
    return out
  }
  return value
}

function scrubJsonLine(line: string, counts: RedactionCounts): string | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  try {
    return JSON.stringify(scrubValue(JSON.parse(trimmed), counts))
  } catch {
    return null
  }
}

/**
 * Redacts one diagnostics file. A whole-file JSON document or a JSON-lines log is scrubbed structurally (content
 * keys dropped, then every remaining string scrubbed); any line that is not JSON gets the string rules.
 */
export function redactDiagnosticsText(input: string): RedactedText {
  const counts = zeroRedactionCounts()
  let whole: string | null = null
  try {
    whole = JSON.stringify(scrubValue(JSON.parse(input), counts), null, 2)
  } catch {
    whole = null
  }
  if (whole !== null) return { text: whole, counts, total: sum(counts) }
  // Not one JSON document: a log. Reset counts the failed whole-file attempt could not have produced.
  const lineCounts = zeroRedactionCounts()
  const lines = input.split('\n').map((line) => scrubJsonLine(line, lineCounts) ?? scrubString(line, lineCounts))
  return { text: lines.join('\n'), counts: lineCounts, total: sum(lineCounts) }
}
