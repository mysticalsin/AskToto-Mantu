/**
 * Métis 2.0 Cap 2 — deterministic mid-sentence command parser.
 * Starts each step as keywords finalize — does not wait for full utterance end.
 * Cap1 /v1/decide may disambiguate ONLY; this path MUST work with Jev off/outage.
 */
import {
  type DesktopActionRequest,
  type DesktopAdapterId,
  desktopActionFingerprint
} from './desktop-actions'
import { foldSpeech, stripWakeWord } from './metis-wake'

export type ParseCommit = {
  request: DesktopActionRequest
  at: number
  confidence: 'deterministic'
}

export type ParseSnapshot = {
  commits: ParseCommit[]
  provisional: DesktopAdapterId[]
  ambiguous: boolean
  negation: boolean
}

const NEGATION_RE =
  /\b(actually\s+don[\u2019']?t|don[\u2019']?t|do not|never mind|cancel that|stop that|scratch that)\b/

type Rule = {
  id: DesktopAdapterId
  allOf: RegExp[]
  build?: (folded: string) => DesktopActionRequest | null
}

const RULES: Rule[] = [
  {
    id: 'desktop.open_notes',
    allOf: [/\bopen(?:\s+up)?\s+notes\b/],
    build: () => ({ id: 'desktop.open_notes', args: {} })
  },
  {
    id: 'desktop.create_note',
    allOf: [
      /\b(create|new|make)\b.*\bnote\b/,
      /\b(title|titled|called|named)\b.*\bhello\b|\bhello\b/
    ],
    build: (folded) => {
      if (!/\bhello\b/.test(folded)) return null
      if (!/\b(create|new|make)\b/.test(folded) || !/\bnote\b/.test(folded)) return null
      return { id: 'desktop.create_note', args: { title: 'hello' } }
    }
  },
  {
    id: 'desktop.open_arc',
    allOf: [/\bopen(?:\s+up)?\s+arc\b|\barc\s+browser\b/],
    build: () => ({ id: 'desktop.open_arc', args: {} })
  },
  {
    id: 'desktop.google_search',
    allOf: [/\b(google|search(?:\s+for)?)\b/, /\bnorbert\s+wiener\b/],
    build: (folded) => {
      if (!/\bnorbert\s+wiener\b/.test(folded)) return null
      return { id: 'desktop.google_search', args: { q: 'Norbert Wiener' } }
    }
  },
  {
    id: 'desktop.open_x',
    allOf: [/\bopen(?:\s+up)?\s+(x\.com|x\b|twitter)\b|\bx\.com\b/],
    build: () => ({ id: 'desktop.open_x', args: {} })
  },
  {
    id: 'desktop.photo_booth_capture',
    allOf: [
      /\bphoto\s*booth\b/,
      /\b(take|capture|snap)\b.*\b(picture|photo|selfie)\b|\btake\s+a\s+picture\b/
    ],
    build: () => ({ id: 'desktop.photo_booth_capture', args: {} })
  }
]

export function parseMetisCommandTranscript(
  rawText: string,
  alreadyCommitted: ReadonlySet<string> = new Set()
): ParseSnapshot {
  const folded = foldSpeech(stripWakeWord(rawText))
  const negation = NEGATION_RE.test(folded)
  const commits: ParseCommit[] = []
  const provisional: DesktopAdapterId[] = []
  let ambiguous = false

  if (!folded) return { commits, provisional, ambiguous, negation }

  for (const rule of RULES) {
    const matched = rule.allOf.every((re) => re.test(folded))
    if (!matched) {
      if (rule.allOf.some((re) => re.test(folded))) provisional.push(rule.id)
      continue
    }
    const req = rule.build ? rule.build(folded) : null
    if (!req) {
      ambiguous = true
      provisional.push(rule.id)
      continue
    }
    const fp = desktopActionFingerprint(req)
    if (alreadyCommitted.has(fp)) continue
    if (negation) {
      provisional.push(rule.id)
      continue
    }
    commits.push({ request: req, at: folded.length, confidence: 'deterministic' })
  }

  const order = new Map(RULES.map((r, i) => [r.id, i]))
  commits.sort((a, b) => (order.get(a.request.id) ?? 99) - (order.get(b.request.id) ?? 99))
  return { commits, provisional, ambiguous, negation }
}
