import { BRAIN_EXTRACTION_PROMPT, MeetingExtractionSchema, type MeetingExtraction } from '@shared/brain'
import { INJECTION_GUARD } from '@shared/prompts'
import { alignQuote, extractNumerals, numeralDerivable, verifyNumericFact } from '@shared/grounding'
import { redactSecrets } from '@shared/redact'
import { localSlotTokens } from '../llm/local'
import { EXTRACTION_REMINDER, fitWindowChars } from './local-extraction-fit'
import { commitmentKey, pushUnique, slugify } from './store'

export const WINDOW_SIZE = 24_000
const WINDOW_OVERLAP = 1000

/** The largest window (chars) whose local extraction request fits a slot of `slotTokens`. */
export function localExtractionWindowChars(slotTokens: number): number {
  return fitWindowChars(slotTokens, buildExtractionSystem(EXTRACTION_REMINDER).length, WINDOW_SIZE)
}

/** The local route sizes windows to its current model slot; cloud routes keep the established limit. */
export function extractionWindowSize(first: { provider: string; model: string } | undefined): {
  size: number
  local: boolean
} {
  if (first?.provider !== 'local') return { size: WINDOW_SIZE, local: false }
  try {
    return { size: localExtractionWindowChars(localSlotTokens(first.model)), local: true }
  } catch {
    return { size: WINDOW_SIZE, local: false }
  }
}

/** Apply optional secret redaction, then split the exact transcript text used for grounding. */
export function prepareMeetingWindows(redactSensitive: boolean, transcriptMd: string, size: number): string[] {
  const overlap = Math.min(WINDOW_OVERLAP, Math.floor(size / 8))
  return splitIntoWindows(redactSensitive ? redactSecrets(transcriptMd) : transcriptMd, size, overlap)
}

/** Strip markdown fences / stray prose around the JSON object a model may still emit. */
export function extractJsonObject(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced ? fenced[1] : raw
  const start = body.indexOf('{')
  if (start === -1) throw new Error('No JSON object in model output')

  // Small on-device models occasionally append a second JSON fragment or a prose note after the
  // requested object. Scan for the first balanced object, respecting braces and escapes in strings.
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < body.length; i++) {
    const ch = body[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return body.slice(start, i + 1)
    }
  }
  throw new Error('No complete JSON object in model output')
}

/** Lead with the injection guard, exactly like personas.ts's buildSystem does for other untrusted modes. */
export const buildExtractionSystem = (extra = ''): string =>
  INJECTION_GUARD.trimStart() + '\n\n' + BRAIN_EXTRACTION_PROMPT + extra

/** Split at transcript line boundaries with trailing context for facts crossing a window edge. */
export function splitIntoWindows(text: string, size = WINDOW_SIZE, overlap = WINDOW_OVERLAP): string[] {
  if (text.length <= size) return [text]
  const lines = text.split('\n')
  const windows: string[] = []
  let cur: string[] = []
  let curLen = 0
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const lineLen = line.length + 1
    if (curLen + lineLen > size && cur.length > 0) {
      windows.push(cur.join('\n'))
      const ov: string[] = []
      let ovLen = 0
      for (let j = cur.length - 1; j >= 0 && ovLen < overlap; j--) {
        ov.unshift(cur[j])
        ovLen += cur[j].length + 1
      }
      // MQA-017: i advances only after this line is accepted. If the overlap seed and this line do not
      // fit together, retrying the same state would emit the same window forever on the main process.
      // Drop overlap in that case; an oversized single line is safer than a synchronous infinite loop.
      if (ovLen + lineLen > size) {
        cur = []
        curLen = 0
      } else {
        cur = ov
        curLen = ovLen
      }
      continue
    }
    cur.push(line)
    curLen += lineLen
    i++
  }
  if (cur.length > 0) windows.push(cur.join('\n'))
  return windows
}

type Deal = NonNullable<MeetingExtraction['deal']>
type Account = NonNullable<MeetingExtraction['account']>

function pickAnchorWindow(windows: MeetingExtraction[]): number {
  const extractedIdx = windows.findIndex((w) => w.account?.confidence === 'EXTRACTED')
  if (extractedIdx !== -1) return extractedIdx
  const nonNullIdx = windows.findIndex((w) => w.account !== null)
  return nonNullIdx !== -1 ? nonNullIdx : 0
}

function combineDeal(windows: MeetingExtraction[]): Deal | null {
  const withDeal = windows.filter((w): w is MeetingExtraction & { deal: Deal } => w.deal !== null)
  if (withDeal.length === 0) return null
  const name = withDeal.find((w) => w.deal.name)?.deal.name ?? ''
  let stage = ''
  let win_likelihood_band: Deal['win_likelihood_band'] = null
  let band_evidence = ''
  let velocity: Deal['velocity'] = { signal: 'no-hard-date-found', evidence: '' }
  let amount: Deal['amount']
  let close_date: Deal['close_date']
  for (const w of withDeal) {
    if (w.deal.stage) stage = w.deal.stage
    if (w.deal.win_likelihood_band) {
      win_likelihood_band = w.deal.win_likelihood_band
      band_evidence = w.deal.band_evidence
    }
    if (w.deal.velocity.signal !== 'no-hard-date-found') velocity = w.deal.velocity
    if (w.deal.amount) amount = w.deal.amount
    if (w.deal.close_date) close_date = w.deal.close_date
  }
  return { name, stage, win_likelihood_band, band_evidence, velocity, amount, close_date }
}

/** Deterministically combine per-window results; single-window callers retain their original object. */
export function combineWindowExtractions(windows: MeetingExtraction[]): MeetingExtraction {
  if (windows.length <= 1) return windows[0]
  const anchor = windows[pickAnchorWindow(windows)]
  const people: MeetingExtraction['people'] = []
  for (const w of windows) for (const p of w.people) pushUnique(people, p, (x) => slugify(x.name))
  const commitments: MeetingExtraction['commitments'] = []
  for (const w of windows) for (const c of w.commitments) pushUnique(commitments, c, (x) => commitmentKey(x.text))
  const signals: MeetingExtraction['signals'] = []
  for (const w of windows) for (const sig of w.signals) pushUnique(signals, sig, (x) => `${x.kind}|${x.statement}`)
  const missed_signals: MeetingExtraction['missed_signals'] = []
  for (const w of windows) for (const m of w.missed_signals) pushUnique(missed_signals, m, (x) => x.statement)
  const feedback: MeetingExtraction['feedback'] = []
  for (const w of windows) for (const f of w.feedback) pushUnique(feedback, f, (x) => x.note)
  const numeric_facts: MeetingExtraction['numeric_facts'] = []
  for (const w of windows) {
    for (const n of w.numeric_facts)
      pushUnique(numeric_facts, n, (x) => `${x.kind}|${x.value}|${x.unit ?? ''}|${x.quote}`)
  }
  return {
    ...anchor,
    title24: anchor.title24,
    topics: anchor.topics,
    sentiment: anchor.sentiment,
    account: anchor.account as Account | null,
    people,
    deal: combineDeal(windows),
    signals,
    missed_signals,
    commitments,
    feedback,
    numeric_facts
  }
}

function stripLanguageMarkers(text: string): string {
  // These labels are renderer-added formatting, not speech. A quote must not ground against one; apply
  // this only to the verification reference, never to the text sent to the model. The fuzzy alignment
  // path can shift slightly around a removed marker, but exact-substring verification stays conservative.
  return text.replace(/^_?\[conversation switches to [^\]]+\]_?$/gm, '')
}

/** Verify numeric facts and commitment quotes against the exact prepared model input. */
export function verifyExtraction(x: MeetingExtraction, preparedText: string): MeetingExtraction {
  const grounding = stripLanguageMarkers(preparedText)
  const numeric_facts = x.numeric_facts.map((f) => {
    const outcome = verifyNumericFact({ value: f.value, quote: f.quote, unit: f.unit ?? undefined }, grounding)
    return outcome === 'verified' ? f : { ...f, confidence: 'AMBIGUOUS' as const }
  })
  const commitments = x.commitments.map((c) => {
    if (!c.quote) return c
    return alignQuote(c.quote, grounding) ? c : { ...c, confidence: 'AMBIGUOUS' as const }
  })
  return { ...x, numeric_facts, commitments }
}

export function verifyDealAmount(amount: Deal['amount'], transcript: string): boolean {
  if (!amount) return false
  return (
    verifyNumericFact(
      { value: amount.value, quote: amount.quote, unit: amount.currency },
      stripLanguageMarkers(transcript)
    ) === 'verified'
  )
}

export function verifyDealCloseDate(closeDate: Deal['close_date'], transcript: string): boolean {
  if (!closeDate || !closeDate.quote) return false
  if (!alignQuote(closeDate.quote, stripLanguageMarkers(transcript))) return false
  const nums = extractNumerals(closeDate.value)
  if (nums.length === 0) return false
  return nums.every((n) => numeralDerivable(n.value, closeDate.quote))
}

export function verifyBandEvidence(bandEvidence: string, transcript: string): boolean {
  return !!bandEvidence && !!alignQuote(bandEvidence, stripLanguageMarkers(transcript))
}

/** Parse model output, discard malformed optional facts and exclude speaker-role pseudo-people. */
export function parseExtractionPayload(raw: string): MeetingExtraction {
  const payload: unknown = JSON.parse(extractJsonObject(raw))
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const extraction = payload as Record<string, unknown>
    if ('numeric_facts' in extraction) {
      const numericFacts = extraction.numeric_facts
      extraction.numeric_facts = Array.isArray(numericFacts)
        ? numericFacts.filter((fact) => {
            if (!fact || typeof fact !== 'object' || Array.isArray(fact)) return false
            const value = (fact as Record<string, unknown>).value
            return typeof value === 'number' && Number.isFinite(value)
          })
        : []
    }
  }
  const result = MeetingExtractionSchema.safeParse(payload)
  if (!result.success) {
    // MQA-114: exposing ZodError.message dumps its full serialized issue array into the user-facing
    // ingest failure. Keep the useful first path while leaving the model output available for retry.
    const issue = result.error.issues[0]
    const where = issue?.path?.length ? issue.path.join('.') : 'the response'
    throw new Error(`The model's summary did not match the expected meeting shape (at ${where}).`)
  }
  // MQA-116: role labels from the transcript are not participant identities; keeping them here creates
  // fake people in the graph. Their commitments are routed separately using the original `by` label.
  result.data.people = result.data.people.filter((p) => !SPEAKER_ROLE_LABELS.has(p.name.trim().toLowerCase()))
  return result.data
}

const SPEAKER_ROLE_LABELS = new Set(['you', 'them', 'me', 'unknown', 'speaker', 'participant', 'other'])
