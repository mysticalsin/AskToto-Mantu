import { describe, it, expect } from 'vitest'
import { alignQuote, type AlignMatch } from './grounding'

/**
 * MQA-150 — alignQuote's fuzzy fallback used to score EVERY start position in the transcript, at
 * O(transcript × quote³). Verification runs synchronously inside ingest on the main process, twice per
 * ingest, for every unaligned quote — so a long meeting froze every window and every IPC reply while it
 * ran (a 120 KB transcript spent 3.3 s of blocked main process on ONE 28-token quote).
 *
 * This file pins BOTH halves of the fix, because speed alone is not the requirement:
 *
 *   1. WORK BOUND — the fuzzy scan must not do work proportional to transcript length when the extra
 *      text cannot contain the quote. Measured as a deterministic COUNT of DP comparisons, never as a
 *      wall-clock budget: this repo has a documented history of timing gates that go red because of
 *      machine load rather than a defect (see the testTimeout note in vitest.config.ts).
 *   2. FIDELITY — alignQuote's output must be IDENTICAL to what it returned before the fix. Every
 *      expectation below was captured by running the pre-fix implementation (commit f180a01's
 *      src/shared/grounding.ts) and pinned verbatim. Narrowing what alignQuote can match would be a
 *      feature regression dressed up as an optimization, and these goldens are what catches it.
 */

// ── the work meter ───────────────────────────────────────────────────────────────────────────────
//
// The LCS recurrence resolves every non-matching cell with `Math.max(prev[j], cur[j - 1])`, so counting
// Math.max calls across an alignQuote call counts DP cells computed — the exact quantity that was cubic.
// It is implementation-independent in the way that matters: the pre-fix and post-fix recurrences are the
// same line, so the same probe measures both, and it is a pure count, so it is identical on every
// machine. `meterIsLive` below stops the bounds from passing vacuously if the recurrence is ever
// rewritten without Math.max.
function dpComparisons(fn: () => unknown): number {
  const realMax = Math.max
  let calls = 0
  Math.max = function (...values: number[]): number {
    calls++
    return realMax.apply(Math, values)
  }
  try {
    fn()
  } finally {
    Math.max = realMax
  }
  return calls
}

// ── corpora ──────────────────────────────────────────────────────────────────────────────────────

const DRIFTED_QUOTE = 'Them: our churn dropped by uh fifteen percent, after the onboarding rework'
const PLANTED_TARGET = 'Them: Our churn dropped by fifteen percent after the onboarding rework.'

/** Filler whose vocabulary is disjoint from every quote used here, so the only start positions that can
 *  possibly clear the threshold are the ones around the single planted target line. */
function fillerLine(i: number): string {
  const w: string[] = []
  for (let k = 0; k < 9; k++) w.push(`zq${((i * 7 + k * 13) % 997).toString(36)}x${k}`)
  return `Alpha: ${w.join(' ')}.`
}
function plantedTranscript(lines: number): string {
  const out: string[] = []
  for (let i = 0; i < lines; i++) out.push(fillerLine(i))
  out.splice(Math.floor(lines / 2), 0, PLANTED_TARGET)
  return out.join('\n')
}

/** A realistic meeting transcript: ordinary sales-call sentences, so query vocabulary recurs throughout
 *  and the anchor guard cannot lean on a disjoint vocabulary. 120 KB is the size that froze the app. */
const SENTENCES = [
  'Them: We reviewed the migration plan with the platform team this morning.',
  'You: That is helpful, can you send over the revised timeline?',
  'Them: The budget approved for phase one is 300k EUR, nothing more.',
  'You: Understood, I will circulate that to finance before Friday.',
  'Them: Our churn dropped by fifteen percent after the onboarding rework.',
  'You: Great, and what about the support backlog you mentioned last week?',
  'Them: It is down to about forty tickets, mostly low severity items.',
  'You: We will deliver the integration report by the end of the quarter.',
  'Them: Procurement wants a security review before any contract is signed.',
  'You: I will book that with our security lead and confirm the date.'
]
function repeatingTranscript(targetBytes: number): string {
  const lines: string[] = []
  let size = 0
  let i = 0
  while (size < targetBytes) {
    const line = SENTENCES[i % SENTENCES.length]
    lines.push(line)
    size += line.length + 1
    i++
  }
  return lines.join('\n')
}
const BIG = repeatingTranscript(120_000)
const LONG_ABSENT_QUOTE =
  'Them: Our churn dropped by uh fifteen percent after the onboarding rework and procurement wants a security review before any contract is signed with the platform team this morning'
const ABSENT_QUOTE = 'Them: we agreed to terminate the renewal and refund the entire retainer immediately'
const LONG_PRESENT_QUOTE = [
  'You: Great, and what about the uh support backlog you mentioned last week?',
  'Them: It is down to about forty tickets, mostly low severity items.',
  'You: We will deliver the integration report by the end of the quarter.'
].join('\n')

describe('MQA-150 — alignQuote fuzzy fallback: work bound', () => {
  // The bound, stated: DP work is a function of how many transcript anchors could possibly clear the
  // threshold, NOT of transcript length. Growing a transcript 8× with text that shares no vocabulary
  // with the quote adds no candidate anchors, so it must add (essentially) no work.
  // Pre-fix this ratio was 8.01 — exactly linear in transcript length.
  it('MQA-150: an 8x longer transcript with no new candidate anchors costs no more DP work', () => {
    const small = dpComparisons(() => alignQuote(DRIFTED_QUOTE, plantedTranscript(100)))
    const large = dpComparisons(() => alignQuote(DRIFTED_QUOTE, plantedTranscript(800)))
    expect(large).toBeLessThanOrEqual(Math.ceil(small * 1.25))
    // Absolute floor on the same case, so the ratio cannot be satisfied by both numbers being huge.
    // Pre-fix: 843_224 for the 7 KB transcript.
    expect(small).toBeLessThan(50_000)
  })

  it('MQA-150: a quote absent from a 120 KB meeting transcript builds no LCS tables at all', () => {
    // Nothing in the transcript shares enough of the quote's vocabulary to clear 0.85, so every start is
    // rejected by the O(1) anchor test and no DP table is ever built. Pre-fix: 19_498_391 comparisons.
    expect(dpComparisons(() => alignQuote(ABSENT_QUOTE, BIG))).toBeLessThan(100)
  })

  it('MQA-150: the worst observed ingest case stays inside a fixed comparison budget', () => {
    // A 28-token quote against 120 KB of dense, repetitive meeting text — the case that blocked the main
    // process for 3.3 s. Pre-fix: 193_888_628 comparisons. Post-fix: 1_640_214.
    expect(dpComparisons(() => alignQuote(LONG_ABSENT_QUOTE, BIG))).toBeLessThan(5_000_000)
    // The quote that DOES align in the same transcript must stay bounded too — pruning must not be
    // paid for by making the matching path slower. Pre-fix: 16_844_909.
    expect(dpComparisons(() => alignQuote(DRIFTED_QUOTE, BIG))).toBeLessThan(5_000_000)
  })

  it('MQA-150: the work meter is live, so the bounds above cannot pass vacuously', () => {
    // A small quote that genuinely reaches the fuzzy path must register real DP work. If the recurrence
    // is ever rewritten without Math.max the meter would read ~0 and every bound above would pass while
    // measuring nothing — this test fails first instead.
    const work = dpComparisons(() =>
      alignQuote('we will deliver the report by Friday', 'Them: uh we will, deliver the report by uh Friday for sure.')
    )
    expect(work).toBeGreaterThan(100)
    expect(work).toBeLessThan(10_000)
    // And the exact path must never reach the DP at all.
    expect(dpComparisons(() => alignQuote('the deal will close by Friday', 'Them: I think the deal will close by Friday, latest.'))).toBe(0)
  })
})

// ── fidelity ─────────────────────────────────────────────────────────────────────────────────────

type Case = { name: string; quote: string; transcript: string; threshold?: number; expected: AlignMatch | null }

const CASES: Case[] = [
  { name: 'exact verbatim', quote: 'the deal will close by Friday', transcript: 'You: ok. Them: I think the deal will close by Friday, latest.', expected: { start: 23, end: 52, score: 1 } },
  { name: 'exact across a reflowed line break', quote: 'the deal will close by Friday', transcript: 'Them: I think the deal will close\n   by Friday, latest.', expected: { start: 14, end: 46, score: 1 } },
  { name: 'exact through casing drift', quote: 'The budget approved for phase one is 300K EUR,', transcript: 'Them: The budget approved for phase one is 300k EUR, nothing more.', expected: { start: 6, end: 52, score: 1 } },
  { name: 'fuzzy scoring 1.0 on interior punctuation drift', quote: 'we will deliver, the report', transcript: 'Them: We will deliver the report by Friday.', expected: { start: 6, end: 32, score: 1 } },
  { name: 'fuzzy through inserted ASR filler', quote: 'we will deliver the report by Friday', transcript: 'Them: uh we will, deliver the report by uh Friday for sure.', expected: { start: 9, end: 49, score: 0.875 } },
  { name: 'fuzzy with a drifted numeral', quote: 'the deal is worth about 3.5M EUR', transcript: 'Them: uh the deal is worth about 3.4M EUR for sure.', expected: { start: 9, end: 41, score: 0.875 } },
  { name: 'fuzzy French with accents', quote: 'Le taux uh de résolution atteint soixante et onze pour cent', transcript: 'Them: Le taux de résolution atteint soixante et onze pour cent ce trimestre.', expected: { start: 0, end: 62, score: 0.9090909090909091 } },
  { name: 'fuzzy tie resolves to the earliest window', quote: 'we uh will deliver the integration report', transcript: 'You: We will deliver the integration report by the end of the quarter.\nThem: ok.\nYou: We will deliver the integration report by the end of the quarter.', expected: { start: 0, end: 43, score: 0.8571428571428571 } },
  { name: 'fuzzy with leading and trailing non-query noise', quote: 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon', transcript: 'zzz alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau yyy', expected: { start: 0, end: 101, score: 0.95 } },
  { name: 'null when the only candidate tail window is too short', quote: 'confirm the date and the security review', transcript: 'Them: Procurement wants a security review before any contract is signed. You: I will book that and confirm the date', expected: null },
  { name: 'null on an unrelated transcript', quote: 'the annual roadmap has several open risk items pending review', transcript: 'Them: The quarterly forecast shows fifteen percent growth in the retail segment.', expected: null },
  { name: 'null at threshold 0.2', quote: 'the annual roadmap has several open risk items pending review', transcript: 'Them: The quarterly forecast shows fifteen percent growth in the retail segment.', threshold: 0.2, expected: null },
  { name: 'match at threshold 0.1', quote: 'the annual roadmap has several open risk items pending review', transcript: 'Them: The quarterly forecast shows fifteen percent growth in the retail segment.', threshold: 0.1, expected: { start: 0, end: 64, score: 0.1 } },
  { name: 'threshold 1.0 still admits the exact path', quote: 'the deal will close by Friday', transcript: 'Them: I think the deal will close by Friday, latest.', threshold: 1, expected: { start: 14, end: 43, score: 1 } },
  { name: 'threshold 1.0 rejects a fuzzy near match', quote: 'we will deliver the report by Friday', transcript: 'Them: uh we will, deliver the report by uh Friday for sure.', threshold: 1, expected: null },
  { name: 'empty quote', quote: '', transcript: 'Them: anything at all here.', expected: null },
  { name: 'whitespace-only quote', quote: '   \n\t ', transcript: 'Them: anything at all here.', expected: null },
  { name: 'empty transcript', quote: 'the deal will close by Friday', transcript: '', expected: null },
  { name: 'quote longer than the whole transcript', quote: 'we will deliver the integration report by the end of the quarter without fail', transcript: 'Them: ok.', expected: null },
  { name: 'single-token quote present', quote: 'procurement', transcript: 'Them: Procurement wants a security review before any contract is signed.', expected: { start: 6, end: 17, score: 1 } },
  { name: 'single-token quote absent', quote: 'procurement', transcript: 'Them: Legal wants a security review before any contract is signed.', expected: null },
  { name: 'unicode vulgar fraction is neutralized, offsets hold', quote: 'the volume dropped by ½ this uh quarter', transcript: 'Them: The volume dropped by ½ this quarter overall.', expected: { start: 0, end: 42, score: 0.8571428571428571 } },
  { name: 'unicode enclosed digit and squared unit', quote: 'the site covers ① plot of 50km² today', transcript: 'Them: The site covers ① plot of 50km² today, per the survey.', expected: { start: 6, end: 43, score: 1 } },
  { name: 'unicode narrow no-break thousands grouping', quote: 'the contract is worth 12 500 EUR uh total', transcript: 'Them: The contract is worth 12 500 EUR total this year.', expected: { start: 0, end: 44, score: 0.8888888888888888 } },
  { name: 'unicode astral emoji does not skew offsets', quote: 'the migration 🚀 plan shipped', transcript: 'Them: The migration 🚀 plan shipped on Tuesday.', expected: { start: 6, end: 35, score: 1 } },
  { name: 'unicode astral emoji near miss stays null', quote: 'the migration 🚀 plan uh shipped', transcript: 'Them: The migration 🚀 plan shipped on Tuesday.', expected: null },
  { name: 'unicode ligature fold shifts offsets, fuzzy still hits', quote: 'the ﬁnal integration report uh is ready for review', transcript: 'Them: The ﬁnal integration report is ready for review this week.', expected: { start: 0, end: 54, score: 0.8888888888888888 } },
  { name: 'unicode ligature near miss stays null', quote: 'the ﬁnal uh report is ready', transcript: 'Them: The ﬁnal report is ready for review.', expected: null },
  { name: 'scrambled tokens are not a match despite full vocabulary overlap', quote: 'the deal will close by Friday', transcript: 'Them: friday by close will deal the, in that order.', expected: null }
]

describe('MQA-150 — alignQuote fuzzy fallback: alignment fidelity', () => {
  for (const c of CASES) {
    it(`MQA-150 fidelity: ${c.name}`, () => {
      const m = c.threshold === undefined ? alignQuote(c.quote, c.transcript) : alignQuote(c.quote, c.transcript, c.threshold)
      expect(m).toEqual(c.expected)
    })
  }

  it('MQA-150 fidelity: 120 KB meeting transcript', () => {
    expect(alignQuote(DRIFTED_QUOTE, BIG)).toEqual({ start: 260, end: 338, score: 0.9166666666666666 })
    expect(alignQuote(LONG_PRESENT_QUOTE, BIG)).toEqual({ start: 332, end: 549, score: 0.9736842105263158 })
    expect(alignQuote(LONG_ABSENT_QUOTE, BIG)).toBeNull()
    expect(alignQuote(ABSENT_QUOTE, BIG)).toBeNull()
  })
})

// ── breadth: a seeded corpus whose whole result set is pinned by digest ───────────────────────────
//
// 29 named goldens cover the shapes we reasoned about; this covers the ones we did not. 900 seeded
// trials sweep transcript length, quote provenance (drawn-with-drift vs unrelated), insertion/deletion/
// substitution drift, trailing punctuation, and eight thresholds. The digest below is the pre-fix
// implementation's answer to all 900 — one changed start, end or score anywhere moves it.

let seed = 987654321
function rnd(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}
function pick<T>(a: T[]): T {
  return a[Math.floor(rnd() * a.length)]
}
const VOCAB =
  'the deal budget team plan we will deliver report by friday 300k eur 3.5m usd fifteen percent churn security review contract signed procurement timeline quarter uh um so like actually revenue grew soixante et onze pour cent le taux de résolution atteint ce trimestre client important quatre vingts mille'.split(
    ' '
  )
const PUNCT = ['', ',', '.', '!', ' —', ' …', "'", '’', ':', ';']
function sentence(n: number): string {
  const w: string[] = []
  for (let i = 0; i < n; i++) w.push(pick(VOCAB))
  return w.join(' ') + pick(PUNCT)
}
function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

describe('MQA-150 — alignQuote fuzzy fallback: seeded corpus fidelity', () => {
  it('MQA-150 fidelity: 900 seeded trials reproduce the pre-fix result set exactly', () => {
    seed = 987654321
    const results: string[] = []
    let nonNull = 0
    let fuzzy = 0
    for (let trial = 0; trial < 900; trial++) {
      const lines: string[] = []
      const nLines = 1 + Math.floor(rnd() * 12)
      for (let i = 0; i < nLines; i++) lines.push(`${rnd() < 0.5 ? 'Them' : 'You'}: ${sentence(2 + Math.floor(rnd() * 18))}`)
      const transcript = lines.join('\n')
      let quote: string
      if (rnd() < 0.6) {
        const src = pick(lines)
        const toks = src.split(' ')
        const from = Math.floor(rnd() * Math.max(1, toks.length - 2))
        const slice = toks.slice(from, from + 2 + Math.floor(rnd() * 14))
        const r = rnd()
        if (r < 0.3) slice.splice(1, 0, 'uh')
        else if (r < 0.5 && slice.length > 2) slice.splice(1, 1)
        else if (r < 0.7) slice.push(pick(VOCAB))
        quote = slice.join(' ') + pick(PUNCT)
      } else {
        quote = sentence(2 + Math.floor(rnd() * 16))
      }
      const m = alignQuote(quote, transcript, pick([0.85, 0.85, 0.85, 0.5, 0.7, 0.95, 1, 0.2]))
      if (m) {
        nonNull++
        if (m.score < 1) fuzzy++
      }
      results.push(m === null ? 'n' : `${m.start},${m.end},${m.score}`)
    }
    // Counts first: when the digest moves, these say WHICH way the behaviour drifted (fewer matches =
    // the aligner was narrowed; more = it was loosened). Both are regressions.
    expect({ nonNull, fuzzy }).toEqual({ nonNull: 391, fuzzy: 237 })
    expect(fnv1a(results.join('|'))).toBe('16cb8d02')
  })
})
