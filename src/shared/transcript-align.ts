import type { TranscriptLine } from './ipc'

/**
 * Speaker Intelligence (Phases A/B) — pure helpers for turning a Microsoft Teams meeting transcript into
 * resolved human names on Métis's own local transcript lines.
 *
 * Two independent pieces live here, both pure (no I/O, no Date.now(), fully unit-testable):
 *   - parseTeamsVtt: turns the raw WebVTT text Graph returns (see main/graph-transcript.ts) into a flat
 *     list of {name, text, tSec} cues. A plain string→data parser has no need for Node/Electron APIs, so
 *     it lives here rather than duplicated in (or awkwardly re-exported from) the main-only network module.
 *   - applySpeakerNames: aligns those cues against Métis's OWN transcript lines (captured live, per audio
 *     channel — mic vs. system audio) by text-overlap + time proximity, and layers a resolved `name` on
 *     top. It NEVER touches `speaker` (them/you/unknown) — that side-attribution is already trustworthy
 *     (it comes from which channel captured the line); `name` is additive context only.
 */

/** One cue parsed out of a Teams transcript VTT file. `tSec` is whatever time base the caller's cues use
 *  — parseTeamsVtt returns cue-relative seconds (WebVTT's own convention); main/graph-transcript.ts shifts
 *  them onto the same absolute epoch-seconds base as TranscriptLine.t before calling applySpeakerNames. */
export interface VttEntry {
  name: string
  text: string
  tSec: number
}

const TIMESTAMP_RE = /(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})/
// Teams' <v Display Name>text</v> "voice span" tag (WebVTT spec). The closing tag is technically optional
// in WebVTT itself; tolerate its absence rather than dropping the cue.
const VOICE_TAG_CLOSED_RE = /^<v\s+([^>]+)>([\s\S]*?)<\/v>\s*$/i
const VOICE_TAG_OPEN_RE = /^<v\s+([^>]+)>([\s\S]*)$/i

function timestampToSeconds(h: string, m: string, s: string, ms: string): number {
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000
}

/**
 * Parse a WebVTT transcript (Graph's `/transcripts/{id}/content?$format=text/vtt`) into cues. Tolerant by
 * design — cue identifier lines (Graph prefixes every cue with a GUID), a missing closing `</v>` tag, and
 * a cue with no voice tag at all (name '') are all handled without throwing; a malformed block is simply
 * skipped rather than aborting the whole parse. Never throws; '' / non-string input yields [].
 */
export function parseTeamsVtt(vtt: string): VttEntry[] {
  const entries: VttEntry[] = []
  if (!vtt || typeof vtt !== 'string') return entries

  // WebVTT cues are separated by a blank line. Splitting on that boundary first, then looking for the
  // timestamp line WITHIN each block, sidesteps the "WEBVTT" header (+ optional metadata) and any "NOTE"
  // blocks entirely — neither ever contains a "-->" line, so both fall through the guard below for free.
  const blocks = vtt.replace(/\r\n/g, '\n').split(/\n\s*\n/)
  for (const block of blocks) {
    const lines = block
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    if (!lines.length) continue

    const tsIndex = lines.findIndex((l) => TIMESTAMP_RE.test(l))
    if (tsIndex === -1) continue // header/NOTE/malformed block — nothing to parse here

    const m = TIMESTAMP_RE.exec(lines[tsIndex])
    if (!m) continue
    const tSec = timestampToSeconds(m[1], m[2], m[3], m[4])

    const payload = lines.slice(tsIndex + 1).join(' ').trim()
    if (!payload) continue

    const voiceMatch = VOICE_TAG_CLOSED_RE.exec(payload) || VOICE_TAG_OPEN_RE.exec(payload)
    if (voiceMatch) {
      entries.push({ name: voiceMatch[1].trim(), text: voiceMatch[2].trim(), tSec })
    } else {
      entries.push({ name: '', text: payload, tSec })
    }
  }
  return entries
}

// --- Alignment ---------------------------------------------------------------------------------------

/** How close (in ms) a local line's timestamp must be to a VTT cue's to even be considered a candidate
 *  match. Generous on purpose: the local line's `t` is when Métis's own ASR finished a chunk, the VTT
 *  cue's is Teams' own transcription pipeline — the two can legitimately drift tens of seconds apart on
 *  the very same utterance without either being "wrong". */
const MATCH_WINDOW_MS = 45_000

/** Minimum normalized token-overlap (Jaccard) for a candidate to count as a real match. */
const MATCH_THRESHOLD = 0.5

/** Lowercased, punctuation-stripped word set. Unicode-aware (\p{L}/\p{N}) because Métis transcribes any
 *  spoken language, not just English (see ipc.ts's outputLanguage setting). */
function tokenize(text: string): Set<string> {
  const cleaned = text.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ')
  return new Set(cleaned.split(/\s+/).filter(Boolean))
}

/** Jaccard similarity (intersection / union) of two token sets. 0 when either side is empty. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const t of a) if (b.has(t)) intersection++
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

/**
 * Layer resolved human names onto Métis's own transcript lines using a Teams transcript's cues.
 *
 * `speaker` (them/you/unknown) is never read for matching purposes and never written — it is already
 * trustworthy (assigned live from which audio channel captured the line) and comes back exactly as
 * given. `name` is purely additive:
 *
 *  - A 'you' line gets `opts.operatorName` directly, with no text matching at all, whenever it's
 *    provided (the signed-in account's own display name — see main/auth.ts's authStatus().name). Métis
 *    already knows with certainty which lines are the operator's, so there is nothing to infer, and a
 *    known-good name always beats a fuzzy guess.
 *  - Every other line (and 'you' lines when no operatorName was given) is matched against `entries` by
 *    normalized-token overlap within a generous time window (see MATCH_WINDOW_MS/MATCH_THRESHOLD above).
 *    The highest-scoring candidate at or above the threshold wins. A cue with an empty/blank name (no
 *    <v> tag in the VTT — see parseTeamsVtt) can still be considered a candidate for scoring purposes but
 *    never actually assigns a name, since there is nothing informative to add.
 *  - A line with no qualifying candidate is returned completely untouched — not even a `name: undefined`
 *    key is added — which is the common case for a line whose Teams counterpart wasn't transcribed, or
 *    for a meeting that has no Teams transcript at all (entries === []).
 *
 * Pure and deterministic: no Date.now(), no mutation of the input array or its line objects.
 */
export function applySpeakerNames(
  lines: TranscriptLine[],
  entries: VttEntry[],
  opts?: { operatorName?: string }
): { lines: TranscriptLine[]; named: number } {
  const operatorName = opts?.operatorName?.trim() || ''
  let named = 0

  const tokenizedEntries = entries.map((e) => ({ entry: e, tokens: tokenize(e.text) }))

  const result = lines.map((line) => {
    if (line.speaker === 'you' && operatorName) {
      named++
      return { ...line, name: operatorName }
    }

    let best: { name: string; score: number } | null = null
    const lineTokens = tokenize(line.text)
    for (const { entry, tokens } of tokenizedEntries) {
      if (Math.abs(entry.tSec * 1000 - line.t) > MATCH_WINDOW_MS) continue
      const name = entry.name.trim()
      if (!name) continue // nothing informative to assign even on a perfect text match
      const score = jaccard(lineTokens, tokens)
      if (score < MATCH_THRESHOLD) continue
      if (!best || score > best.score) best = { name, score }
    }
    if (!best) return line
    named++
    return { ...line, name: best.name }
  })

  return { lines: result, named }
}
