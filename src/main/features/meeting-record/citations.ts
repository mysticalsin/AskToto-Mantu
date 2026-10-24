import type { Citation } from '@shared/meeting-record'
import type { TranscriptLine } from '@shared/transcript-line'
import { foldRecapLabel } from '../../transcripts-recap'

/** PROPOSED: a citation needs at least half the item's tokens, and at least two, inside one 1-3 line window. */
const MIN_SCORE = 0.5
const MIN_SHARED = 2
const MAX_WINDOW = 3

const STOPWORDS = new Set(
  (
    'the and for with that this will have from are was were been not but you your our their they them can could would ' +
    'should about into over after before then than also just need needs has had who what when where which ' +
    'les des une que qui pour dans sur avec pas est sont nous vous ils elles aux par ' +
    'uma uns para com por nao mais como foi sao ser tem seu sua nos'
  ).split(' ')
)

const SPLIT = /[^\p{L}\p{N}]+/u

export function tokens(text: string): Set<string> {
  const out = new Set<string>()
  for (const t of foldRecapLabel(text).split(SPLIT)) {
    if (t.length >= 3 && !STOPWORDS.has(t)) out.add(t)
  }
  return out
}

/** Deterministic, local, no model: the best 1-3 line window whose tokens cover the item, earliest on a tie. */
export function citeItem(text: string, lines: readonly TranscriptLine[]): Citation | null {
  const wanted = tokens(text)
  if (wanted.size === 0 || lines.length === 0) return null
  const perLine = lines.map((l) => tokens(l.text))
  let best: { from: number; to: number; score: number } | null = null
  for (let from = 0; from < lines.length; from++) {
    const window = new Set<string>()
    for (let to = from; to < Math.min(lines.length, from + MAX_WINDOW); to++) {
      for (const t of perLine[to]) window.add(t)
      let shared = 0
      for (const t of wanted) if (window.has(t)) shared++
      const score = shared / wanted.size
      if (shared < MIN_SHARED || score < MIN_SCORE) continue
      // Higher coverage wins; at equal coverage the narrower window; then the earliest (strict comparisons).
      if (!best || score > best.score || (score === best.score && to - from < best.to - best.from))
        best = { from, to, score }
    }
  }
  if (!best) return null
  const slice = lines.slice(best.from, best.to + 1)
  return {
    fromLine: best.from,
    toLine: best.to,
    fromT: slice[0].t,
    toT: slice[slice.length - 1].t,
    utteranceIds: slice.flatMap((l) => (l.utteranceId ? [l.utteranceId] : []))
  }
}

function windowOf(lines: readonly TranscriptLine[], range: Citation): TranscriptLine[] {
  return lines.slice(range.fromLine, range.toLine + 1)
}

/** An owner survives only when the cited range names them in its text or in a line's resolved speaker name. */
export function supportsOwner(owner: string, lines: readonly TranscriptLine[], range: Citation): boolean {
  const wanted = foldRecapLabel(owner)
    .split(SPLIT)
    .filter((t) => t.length > 0)
  if (wanted.length === 0) return false
  const have = new Set<string>()
  for (const l of windowOf(lines, range)) {
    for (const t of foldRecapLabel(l.text).split(SPLIT)) have.add(t)
    if (l.name) for (const t of foldRecapLabel(l.name).split(SPLIT)) have.add(t)
  }
  return wanted.every((t) => have.has(t))
}

/** A due phrase survives only when every one of its words appears in the cited range. */
export function supportsDue(due: string, lines: readonly TranscriptLine[], range: Citation): boolean {
  const wanted = foldRecapLabel(due)
    .split(SPLIT)
    .filter((t) => t.length > 0)
  if (wanted.length === 0) return false
  const have = new Set(windowOf(lines, range).flatMap((l) => foldRecapLabel(l.text).split(SPLIT)))
  return wanted.every((t) => have.has(t))
}
