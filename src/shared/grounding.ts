/**
 * Grounding — deterministic verifier core for "no unverified number ever shown".
 *
 * Pure TS, zero I/O, zero deps. Later wired into `verifyExtraction()` in the ingest pipeline, so its
 * API is intentionally small and reusable: align a quoted span inside a transcript, read every number
 * expressible in that span, and check a claimed (value, unit) pair is actually derivable from it.
 *
 * FAIL CLOSED: a false "verified" here is a product-integrity bug (a hallucinated number reaches the
 * user labeled as proven); a false "unverified" only routes to a human-pin flow. Every ambiguous case
 * below is resolved toward producing fewer/no hits rather than guessing a value into existence.
 */

// ── shared normalization ─────────────────────────────────────────────────────────────────────────

/** NFKC compatibility-decomposes several characters into fabricated digit tokens that were never
 *  written as digits in the source: vulgar fractions ('½' -> '1⁄2'), superscript/subscript digits
 *  ('²' -> '2'), the precomposed area/volume glyphs ('㎡' -> 'm2'), and the enclosed-alphanumerics
 *  ('①' -> '1', '⑴' -> '(1)'). Left alone, these would hand numeral extraction digits nobody said
 *  (e.g. "reduced by ½" fabricating 1 AND 2 as separate hits). Neutralized to same-length spaces
 *  BEFORE NFKC folding — caught before NFKC collapses them into ordinary-looking digits — so they
 *  never contribute a digit token: fail closed (no hit) rather than fabricate one.
 *
 *  Area/volume UNIT tokens are blanked WHOLE, not just their superscript: "m²", "km²", "50Mm³", and
 *  the precomposed ㎡㎢㎥㎦. Blanking only the '²' would strand the SI-prefix letter — '50km²' -> '50k'
 *  — and that leftover 'k' then reads as a ×1000 magnitude suffix, fabricating 50,000 (a WORSE lie
 *  than the bare '2' the raw superscript would have produced). So any letter-run immediately followed
 *  by a square/cube superscript is treated as one unit token and erased. A bare superscript with NO
 *  preceding letters ('3²') is left to the fraction/superscript pass below — neutralized to nothing,
 *  never turned into an exponent value. A genuine magnitude ('50k EUR', where 'k' is NOT followed by
 *  a superscript) is untouched and still parses to 50,000.
 *
 *  Enclosed/circled markers (①⑴⑵…, ㉑–㊿, 🄀–🄊) are list-bullet or decorative glyphs, never a stated
 *  numeric value, yet NFKC folds them to digit strings ('①'->'1', '㊿'->'50', '🄀'->'0.'); '⑴' even
 *  decomposes to the 3-char "(1)", which would fabricate a digit AND skew every downstream offset.
 *  The three enclosed blocks — U+2460–U+24FF (Enclosed Alphanumerics), U+3200–U+32FF (Enclosed CJK
 *  Letters/Months, incl. circled 21–50), U+1F100–U+1F1FF (Enclosed Alphanumeric Supplement) — are each
 *  replaced with same-length spaces (2 code units for the astral supplement) so no digit is fabricated
 *  and no offset skews. This deliberately does NOT touch legitimately-authored digit characters:
 *  fullwidth '０'–'９' (U+FF10–U+FF19) and mathematical bold/double-struck '𝟎'–'𝟿' (U+1D7CE–U+1D7FF)
 *  are real digits and stay parseable via their normal NFKC fold to ASCII. */
function neutralizeNumericArtifacts(s: string): string {
  let out = s.replace(/\p{L}+[²³]|[㎡㎢㎥㎦]/gu, (m) => ' '.repeat(m.length))
  out = out.replace(/[¼-¾⅐-⅟²³¹⁰-₟]/g, ' ')
  out = out.replace(/[①-⓿㈀-㋿\u{1f100}-\u{1f1ff}]/gu, (m) => ' '.repeat(m.length))
  return out
}

// NFKC + casefold. Assumed length/position-preserving for the English/French business text this app
// handles (composed Latin + accented letters) — good enough to reuse offsets straight into the
// original string. Decomposed input or exotic scripts are out of scope (see module doc: fail closed).
// Numeric compatibility artifacts (see neutralizeNumericArtifacts) are stripped BEFORE normalize() so
// every consumer of this folded text — alignQuote's matcher AND verifyNumericFact's rule (c) span
// slice AND extractNumerals — shares one consistent, artifact-free index space.
function foldCase(s: string): string {
  return neutralizeNumericArtifacts(s).normalize('NFKC').toLowerCase()
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ── alignQuote ───────────────────────────────────────────────────────────────────────────────────

export type AlignMatch = { start: number; end: number; score: number }

function tokenizeWords(s: string): { tok: string; start: number; end: number }[] {
  const out: { tok: string; start: number; end: number }[] = []
  // Unit symbols (%, €, $, £) are tokens in their own right: a quote ending in "15%" must produce a
  // fuzzy window whose span still contains the '%', or the span-side unit check would reject a
  // genuinely correct fact whose unit symbol trails the last word token.
  const re = /[\p{L}\p{N}]+|[%€$£]/gu
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) out.push({ tok: m[0], start: m.index, end: m.index + m[0].length })
  return out
}

// Length of the longest common SUBSEQUENCE of `a` and the `b[from, to)` slice — tolerant of tokens
// inserted into `b` (ASR filler words like "uh") without giving them any credit, since they simply
// don't extend the subsequence. Missing/substituted `a` tokens cost exactly one point each.
// The window is passed as a RANGE into the caller's flat token array rather than as its own array:
// alignQuote scores O(quote) overlapping windows per anchor, and materializing each one cost a
// slice() + map() allocation per window on top of this table (MQA-150).
function lcsLen(a: string[], b: string[], from: number, to: number): number {
  const n = to - from
  // Two reused rows: the recurrence only ever reads the previous row and the cells already written in
  // the current one, so swapping buffers is equivalent to allocating a fresh row per i.
  let prev = new Array<number>(n + 1).fill(0)
  let cur = new Array<number>(n + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[from + j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1])
    }
    const spent = prev
    prev = cur
    cur = spent
  }
  return prev[n]
}

/** Find `quote` in `transcript`. Exact indexOf (after NFKC + whitespace-collapse + casefold normalization) first;
 *  otherwise sliding-window token-level fuzzy match. Returns null when best score < threshold. */
export function alignQuote(quote: string, transcript: string, threshold = 0.85): AlignMatch | null {
  const q = foldCase(quote).trim()
  const t = foldCase(transcript)
  if (!q) return null

  // Exact path: any run of whitespace in the quote matches ANY run of whitespace in the transcript,
  // so reflowed/re-wrapped transcript text still hits without needing to remap indices post-collapse.
  const words = q.split(/\s+/).filter(Boolean)
  if (words.length > 0) {
    const pattern = words.map(escapeRegex).join('\\s+')
    const exact = new RegExp(pattern).exec(t)
    if (exact) return { start: exact.index, end: exact.index + exact[0].length, score: 1 }
  }

  // Fuzzy path: token-level sliding window scored by longest-common-subsequence overlap against the
  // query tokens — tolerant of inserted filler words and punctuation drift, not of substituted content.
  const queryTokens = tokenizeWords(q).map((x) => x.tok)
  const transcriptTokens = tokenizeWords(t)
  if (queryTokens.length === 0 || transcriptTokens.length === 0) return null

  const qLen = queryTokens.length
  const tLen = transcriptTokens.length
  const transcriptWords = transcriptTokens.map((x) => x.tok)
  const slack = Math.max(2, Math.ceil(qLen * 0.3))

  // MQA-150 — anchor guard. Scoring EVERY start position costs O(transcript × quote³): the LCS table
  // alone is O(quote × window) and it is rebuilt for ~0.3·quote widths at each of the transcript's
  // tokens, so a 120 KB transcript spent seconds of BLOCKED MAIN PROCESS on a single quote (verification
  // runs synchronously inside ingest). `hits[i]` counts how many of the first i transcript tokens are
  // query tokens; a start whose WIDEST window cannot even contain enough query tokens to clear
  // `threshold` cannot produce a match, so its LCS tables are never built.
  //
  // Verdict-preserving, not a heuristic narrowing: LCS length is bounded by the number of window tokens
  // that appear in the query at all, and every enumerated window is either >= qLen long (so the score
  // divisor is its own length, >= qLen) or a short tail window (divisor qLen) — so
  // min(hits, qLen) / qLen is an upper bound on the score of EVERY window at that start. Skipping a
  // start whose upper bound is below `threshold` therefore only ever discards windows that could not
  // have been returned: if the true best clears the threshold it is still enumerated (and reached in the
  // same start/len order, so an equal-scoring tie still resolves to the same earliest window), and if it
  // does not, the function returns null either way.
  const queryVocabulary = new Set(queryTokens)
  const hits = new Int32Array(tLen + 1)
  for (let i = 0; i < tLen; i++) hits[i + 1] = hits[i] + (queryVocabulary.has(transcriptWords[i]) ? 1 : 0)

  let best: AlignMatch | null = null
  scan: for (let start = 0; start < tLen; start++) {
    const maxLen = Math.min(qLen + slack, tLen - start)
    if (Math.min(hits[start + maxLen] - hits[start], qLen) / qLen < threshold) continue
    for (let len = Math.min(qLen, maxLen); len <= maxLen; len++) {
      const overlap = lcsLen(queryTokens, transcriptWords, start, start + len)
      // Score 1.0 is reserved for a genuine verbatim (post-normalization) contiguous match — the exact
      // path above already claims those, so anything reaching this fuzzy path is by definition NOT a
      // literal substring. Dividing by max(queryLen, windowLen) rather than queryLen alone means any
      // window wider than the query (i.e. one that had to skip/absorb extra transcript tokens to align
      // — inserted filler, a substituted/rejected number nearby, ASR noise) scores strictly < 1: the
      // window can only reach the query's own length when it contains nothing but the query's tokens.
      const score = overlap / Math.max(qLen, len)
      if (!best || score > best.score) {
        best = { start: transcriptTokens[start].start, end: transcriptTokens[start + len - 1].end, score }
        // Nothing can beat 1 (overlap can never exceed the divisor) and a later tie would lose to this
        // window anyway on the strict `>` above, so the remaining scan cannot change the answer.
        if (score >= 1) break scan
      }
    }
  }
  if (!best || best.score < threshold) return null
  return best
}

// ── extractNumerals ──────────────────────────────────────────────────────────────────────────────

export type NumeralHit = { value: number; unit: string | null; raw: string }

/** Parse a digit run (already isolated by NUM_TOKEN_RE) that may use '.', ',' or U+202F (narrow
 *  no-break space) as a thousands-group or decimal separator. Never mixes separator kinds — mixed forms are out of the
 *  documented scope and return null (fail closed) rather than guessing. */
function parseDigitGroup(raw: string): number | null {
  const s = raw.replace(/\u202f/g, ' ')
  const hasDot = s.includes('.')
  const hasComma = s.includes(',')
  const hasSpace = s.includes(' ')
  if ((hasDot && hasComma) || (hasDot && hasSpace) || (hasComma && hasSpace)) return null

  if (hasSpace) {
    const parts = s.split(' ')
    if (parts.some((p, i) => i > 0 && p.length !== 3)) return null
    return Number(parts.join(''))
  }
  if (hasDot || hasComma) {
    const sep = hasDot ? '.' : ','
    const parts = s.split(sep)
    if (parts.length === 2 && parts[1].length === 3) {
      // Ambiguous 3-trailing-digit case — per spec, resolved as a thousands grouping, not a decimal.
      return Number(parts[0] + parts[1])
    }
    if (parts.length === 2) return Number(`${parts[0]}.${parts[1]}`)
    if (parts.length > 2) {
      if (parts.slice(1).some((p) => p.length !== 3)) return null // not a clean thousands chain
      return Number(parts.join(''))
    }
    return null
  }
  return /^\d+$/.test(s) ? Number(s) : null
}

const MAG_LETTER: [string, number][] = [
  ['bn', 1e9],
  ['mio', 1e6],
  ['b', 1e9],
  ['m', 1e6],
  ['k', 1e3]
]
const MAG_WORD_EN: [string, number][] = [
  ['billion', 1e9],
  ['million', 1e6],
  ['thousand', 1e3]
]
const MAG_WORD_FR: [string, number][] = [
  ['milliards', 1e9],
  ['milliard', 1e9],
  ['millions', 1e6],
  ['million', 1e6],
  ['mille', 1e3]
]
const CUR_SYM: Record<string, string> = { '€': 'EUR', $: 'USD', '£': 'GBP' }
const CUR_CODE: [string, string][] = [
  ['eur', 'EUR'],
  ['usd', 'USD'],
  ['gbp', 'GBP']
]

/** True when `s[pos..]` starts with `word` as a whole word (not a prefix of a longer word). */
function startsWithWord(s: string, pos: number, word: string): boolean {
  if (!s.startsWith(word, pos)) return false
  const after = s[pos + word.length]
  return after === undefined || !/[a-z]/.test(after)
}

/** True when `s[..pos)` ends with `word` as a whole word. */
function endsWithWord(s: string, pos: number, word: string): boolean {
  const start = pos - word.length
  if (start < 0 || s.slice(start, pos) !== word) return false
  const before = s[start - 1]
  return before === undefined || !/[a-z]/.test(before)
}

/** Candidate positions for a suffix continuing at `pos`: directly adjacent, or after ONE space. */
function suffixSpots(s: string, pos: number): number[] {
  return s[pos] === ' ' ? [pos, pos + 1] : [pos]
}

/** Consume an optional magnitude + currency + percent suffix starting at `pos` in folded string `s`.
 *  Returns the new end position and any multiplier/unit found (defaults: magnitude 1, unit null). */
function consumeSuffix(s: string, pos: number): { end: number; magnitude: number; unit: string | null } {
  let end = pos
  let magnitude = 1
  let unit: string | null = null

  const spot = s[end] === ' ' ? end + 1 : end
  let magFound = false
  for (const [w, mult] of MAG_LETTER) {
    if (startsWithWord(s, spot, w)) {
      magnitude = mult
      end = spot + w.length
      magFound = true
      break
    }
  }
  if (!magFound) {
    for (const [w, mult] of [...MAG_WORD_EN, ...MAG_WORD_FR]) {
      if (startsWithWord(s, spot, w)) {
        magnitude = mult
        end = spot + w.length
        break
      }
    }
  }

  currency: for (const spot2 of suffixSpots(s, end)) {
    const sym = s[spot2]
    if (sym && CUR_SYM[sym]) {
      unit = CUR_SYM[sym]
      end = spot2 + 1
      break
    }
    for (const [code, iso] of CUR_CODE) {
      if (startsWithWord(s, spot2, code)) {
        unit = iso
        end = spot2 + code.length
        break currency
      }
    }
  }

  if (!unit) {
    for (const spot3 of suffixSpots(s, end)) {
      if (s[spot3] === '%') {
        unit = '%'
        end = spot3 + 1
        break
      }
      if (startsWithWord(s, spot3, 'pour cent')) {
        unit = '%'
        end = spot3 + 'pour cent'.length
        break
      }
      if (startsWithWord(s, spot3, 'percent')) {
        unit = '%'
        end = spot3 + 'percent'.length
        break
      }
    }
  }

  return { end, magnitude, unit }
}

/** Consume an optional currency prefix ending exactly at `pos` (symbol adjacent, or a code with an
 *  optional single space before the number). Returns the new start position and any unit found. */
function consumePrefix(s: string, pos: number): { start: number; unit: string | null } {
  const sym = s[pos - 1]
  if (sym && CUR_SYM[sym]) return { start: pos - 1, unit: CUR_SYM[sym] }
  const spot = s[pos - 1] === ' ' ? pos - 1 : pos
  for (const [code, iso] of CUR_CODE) {
    if (endsWithWord(s, spot, code)) return { start: spot - code.length, unit: iso }
  }
  return { start: pos, unit: null }
}

// Matches a digit-and-separator run. Thousands grouping across a space is recognized ONLY for
// U+202F (narrow no-break space) — the typographic separator actually used for grouping. A bare
// ASCII space between digit runs is two independent numerals ("20 200" states 20 and 200, never a
// fabricated 20200 — fail closed). '.'/',' runs go to parseDigitGroup for semantic disambiguation.
const NUM_TOKEN_RE = /\d+(?:\u202f\d{3})+|\d+(?:[.,]\d+)*/g

const EN_UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9
}
const EN_TEENS: Record<string, number> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19
}
const EN_TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90
}

function parseEnglishTensUnits(tokens: string[], i: number): { value: number; next: number } | null {
  if (EN_TENS[tokens[i]] !== undefined) {
    let v = EN_TENS[tokens[i]]
    let j = i + 1
    if (EN_UNITS[tokens[j]] !== undefined) {
      v += EN_UNITS[tokens[j]]
      j++
    }
    return { value: v, next: j }
  }
  if (EN_TEENS[tokens[i]] !== undefined) return { value: EN_TEENS[tokens[i]], next: i + 1 }
  if (EN_UNITS[tokens[i]] !== undefined) return { value: EN_UNITS[tokens[i]], next: i + 1 }
  return null
}

function parseEnglishInt(tokens: string[], i: number): { value: number; next: number } | null {
  // Bare "hundred" (no leading multiplicand) = 100.
  if (tokens[i] === 'hundred') return { value: 100, next: i + 1 }

  // "N hundred" where N is ANY parsed tens/units/teens phrase — a bare unit ("nine hundred") or a full
  // compound ("twenty-five hundred" = 2500, "fifteen hundred" = 1500). Trying the full tens/units parse
  // first (rather than only a single unit word) means the leading multiplicand is never emitted as a
  // standalone hit when it turns out to be part of a "N hundred" multiplier compound.
  const tu = parseEnglishTensUnits(tokens, i)
  if (tu && tokens[tu.next] === 'hundred') {
    let value = tu.value * 100
    let j = tu.next + 1
    if (tokens[j] === 'and') j++
    const rest = parseEnglishTensUnits(tokens, j)
    if (rest) {
      value += rest.value
      j = rest.next
    }
    return { value, next: j }
  }
  return tu
}

/** English number-word phrase starting at token `i`: integer (incl. hundred), optional "point" decimal,
 *  optional magnitude word (thousand/million/billion). Null when no number starts here. */
function parseEnglishNumber(tokens: string[], i: number): { value: number; next: number } | null {
  const intPart = parseEnglishInt(tokens, i)
  if (!intPart) return null
  let value = intPart.value
  let j = intPart.next

  if (tokens[j] === 'point') {
    let k = j + 1
    let frac = ''
    while (EN_UNITS[tokens[k]] !== undefined) {
      frac += String(EN_UNITS[tokens[k]])
      k++
    }
    if (frac) {
      value += Number(`0.${frac}`)
      j = k
    }
  }

  for (const [w, mult] of MAG_WORD_EN) {
    if (tokens[j] === w) {
      value *= mult
      j++
      break
    }
  }
  return { value, next: j }
}

const FR_UNITS: Record<string, number> = {
  zero: 0, un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9
}
const FR_TEENS: Record<string, number> = {
  dix: 10, onze: 11, douze: 12, treize: 13, quatorze: 14, quinze: 15, seize: 16
}
const FR_TENS: Record<string, number> = {
  vingt: 20, trente: 30, quarante: 40, cinquante: 50, soixante: 60
}

function parseFrenchTensUnits(tokens: string[], i: number): { value: number; next: number } | null {
  // 71 is the ONE exception in the 70s: "soixante et onze" (60 + "et" + the TEEN onze), not a direct
  // compound like the rest of the decade — must be intercepted here before the generic tens-branch
  // below (which only joins "et" to a bare UNIT, not a TEEN) fragments it into 60 + 11.
  if (tokens[i] === 'soixante' && tokens[i + 1] === 'et' && tokens[i + 2] === 'onze') {
    return { value: 71, next: i + 3 }
  }
  // 70-79: soixante + (dix..seize); 77-79 add a further unit token after "dix" (dix-sept = 17, etc).
  if (tokens[i] === 'soixante' && FR_TEENS[tokens[i + 1]] !== undefined) {
    let v = 60 + FR_TEENS[tokens[i + 1]]
    let j = i + 2
    if (tokens[i + 1] === 'dix' && FR_UNITS[tokens[j]] !== undefined && FR_UNITS[tokens[j]] >= 7) {
      v += FR_UNITS[tokens[j]]
      j++
    }
    return { value: v, next: j }
  }
  // 80-99: quatre-vingt(s) [+ dix..seize [+ unit] | + unit]. Invariable "quatre-vingts" (with the
  // plural s) is used for bare 80; "quatre-vingt" (no s) when a further number word follows.
  if (tokens[i] === 'quatre' && (tokens[i + 1] === 'vingt' || tokens[i + 1] === 'vingts')) {
    let j = i + 2
    let v = 80
    if (FR_TEENS[tokens[j]] !== undefined) {
      const teenTok = tokens[j]
      v += FR_TEENS[teenTok]
      j++
      if (teenTok === 'dix' && FR_UNITS[tokens[j]] !== undefined && FR_UNITS[tokens[j]] >= 7) {
        v += FR_UNITS[tokens[j]]
        j++
      }
    } else if (FR_UNITS[tokens[j]] !== undefined) {
      v += FR_UNITS[tokens[j]]
      j++
    }
    return { value: v, next: j }
  }
  if (FR_TENS[tokens[i]] !== undefined) {
    let v = FR_TENS[tokens[i]]
    let j = i + 1
    if (tokens[j] === 'et' && FR_UNITS[tokens[j + 1]] !== undefined) {
      v += FR_UNITS[tokens[j + 1]]
      j += 2
    } else if (FR_UNITS[tokens[j]] !== undefined) {
      v += FR_UNITS[tokens[j]]
      j++
    }
    return { value: v, next: j }
  }
  if (FR_TEENS[tokens[i]] !== undefined) return { value: FR_TEENS[tokens[i]], next: i + 1 }
  // Bare "un"/"une" is the indefinite article far more often than the numeral one in ordinary prose
  // ("un client important") — only accept it as a standalone unit when a caller-level check (below)
  // confirms magnitude/hundred context follows; on its own here it is NOT treated as a numeral.
  if (tokens[i] === 'un' || tokens[i] === 'une') return null
  if (FR_UNITS[tokens[i]] !== undefined) return { value: FR_UNITS[tokens[i]], next: i + 1 }
  return null
}

/** French number-word phrase starting at token `i`: (unit)? cent, tens/units/teens, optional "virgule"
 *  decimal, optional magnitude word (mille/million(s)/milliard(s)), optional "et demi". */
function parseFrenchNumber(tokens: string[], i: number): { value: number; next: number } | null {
  let value: number
  let j = i
  let hasCent = false
  if (
    FR_UNITS[tokens[j]] !== undefined &&
    tokens[j] !== 'un' &&
    tokens[j] !== 'une' &&
    (tokens[j + 1] === 'cent' || tokens[j + 1] === 'cents')
  ) {
    // "cents" (plural, no further digits) and "cent" (singular, used when a tens/units group
    // follows, e.g. "deux cent cinquante") are both accepted here — never emit the bare leading
    // unit ("deux") as a standalone hit when it forms a "N cent(s)" multiplier compound.
    value = FR_UNITS[tokens[j]] * 100
    j += 2
    hasCent = true
  } else if (tokens[j] === 'cent') {
    value = 100
    j += 1
    hasCent = true
  } else if ((tokens[j] === 'un' || tokens[j] === 'une') && tokens[j + 1] === 'cent') {
    value = 100
    j += 2
    hasCent = true
  } else {
    const tu = parseFrenchTensUnits(tokens, j)
    // A bare standalone "un"/"une" only counts as a numeral when followed by a magnitude word —
    // otherwise it reads as the indefinite article and is skipped entirely (fail closed).
    if (!tu) {
      if ((tokens[j] === 'un' || tokens[j] === 'une') && [...MAG_WORD_FR].some(([w]) => tokens[j + 1] === w)) {
        value = FR_UNITS[tokens[j]]
        j += 1
      } else {
        return null
      }
    } else {
      value = tu.value
      j = tu.next
    }
  }
  // "cent" combines with a following tens/units group ("cent cinquante" = 150, "deux cent
  // cinquante" = 250) — parseFrenchTensUnits returns null when nothing valid follows (e.g. a
  // magnitude word or end of phrase comes next), so this is a no-op in the bare-"cent" case.
  if (hasCent) {
    const rest = parseFrenchTensUnits(tokens, j)
    if (rest) {
      value += rest.value
      j = rest.next
    }
  }

  if (tokens[j] === 'virgule') {
    let k = j + 1
    let frac = ''
    while (FR_UNITS[tokens[k]] !== undefined) {
      frac += String(FR_UNITS[tokens[k]])
      k++
    }
    if (frac) {
      value += Number(`0.${frac}`)
      j = k
    }
  }

  let magnitude = 1
  for (const [w, mult] of MAG_WORD_FR) {
    if (tokens[j] === w) {
      magnitude = mult
      j++
      break
    }
  }
  value *= magnitude

  if (tokens[j] === 'et' && tokens[j + 1] === 'demi') {
    value += magnitude * 0.5
    j += 2
  }

  return { value, next: j }
}

/** NFKC folds U+202F down to a plain space, which would erase the ONLY space form we accept for
 *  thousands grouping (an ASCII space between digit runs is two independent numerals, never a group).
 *  Re-stamp the original NNBSP positions after folding — NFKC is length-preserving for the supported
 *  text; if it ever isn't, grouping is simply not recognized there (fail closed, fewer hits). */
function foldForNumerals(span: string): string {
  const folded = foldCase(span)
  if (folded.length !== span.length || !span.includes('\u202f')) return folded
  // NET-ZERO-SHIFT HARDENING (MI-4 review): equal overall length does NOT prove position-for-position
  // correspondence. A ligature earlier in the span ('\ufb01' -> 'fi', +1 char) and a decomposed accent
  // later in the SAME span ('e' + combining acute -> '\u00e9', -1 char) can cancel out \u2014 folded.length
  // ends up equal to span.length by coincidence, while every position between the two shifts is off by
  // one. Blindly re-stamping by index at that point reads span[i] (a genuine NNBSP) but writes over
  // folded[i], which \u2014 because of the shift \u2014 is actually a DIGIT there, not the space the NNBSP folded
  // to, splicing a stray space into the middle of a digit run and fragmenting it (e.g. a real 12500
  // misread as a bare "1" plus a corrupted remainder \u2014 a fabricated hit that was never written).
  // Verify EVERY stamped position actually lands on a space in the folded text FIRST; any mismatch means
  // the length check's equality was coincidental, not real correspondence \u2014 fall back to the un-stamped
  // folded text entirely (fail closed: the grouping is simply not recognized there, same "fewer hits"
  // fallback as the length-mismatch case above).
  for (let i = 0; i < span.length; i++) {
    if (span[i] === '\u202f' && folded[i] !== ' ') return folded
  }
  let out = ''
  for (let i = 0; i < folded.length; i++) out += span[i] === '\u202f' ? '\u202f' : folded[i]
  return out
}

/** Extract every numeric value expressible in the span, normalized to a plain number.
 *  unit is '%', an ISO-ish currency ('EUR','USD','GBP'), or null. */
export function extractNumerals(span: string): NumeralHit[] {
  const s = foldForNumerals(span)
  const hits: NumeralHit[] = []
  const consumedTo: boolean[] = new Array(s.length + 1).fill(false)

  const mark = (from: number, to: number): void => {
    for (let k = from; k < to; k++) consumedTo[k] = true
  }
  const isFree = (from: number, to: number): boolean => {
    for (let k = from; k < to; k++) if (consumedTo[k]) return false
    return true
  }

  // Pass 1: digit-based numerals.
  for (const m of s.matchAll(NUM_TOKEN_RE)) {
    const rawStart = m.index!
    const rawEnd = rawStart + m[0].length
    const base = parseDigitGroup(m[0])
    if (base === null) continue
    const pre = consumePrefix(s, rawStart)
    const post = consumeSuffix(s, rawEnd)
    const start = pre.start
    const end = post.end
    if (!isFree(start, end)) continue
    mark(start, end)
    hits.push({ value: base * post.magnitude, unit: pre.unit ?? post.unit, raw: span.slice(start, end) })
  }

  // Pass 2: word-based numerals (English then French), skipping ranges already consumed by pass 1.
  const tokens = tokenizeWords(s)
  const tokWords = tokens.map((t) => t.tok)
  let i = 0
  while (i < tokens.length) {
    if (!isFree(tokens[i].start, tokens[i].end)) {
      i++
      continue
    }
    const en = parseEnglishNumber(tokWords, i)
    const fr = en ? null : parseFrenchNumber(tokWords, i)
    const parsed = en ?? fr
    if (!parsed || parsed.next === i) {
      i++
      continue
    }
    const start = tokens[i].start
    const end = tokens[parsed.next - 1].end
    if (!isFree(start, end)) {
      i = parsed.next
      continue
    }
    const pre = consumePrefix(s, start)
    const post = consumeSuffix(s, end)
    const fullStart = pre.start
    const fullEnd = post.end
    if (!isFree(fullStart, fullEnd)) {
      i = parsed.next
      continue
    }
    mark(fullStart, fullEnd)
    hits.push({ value: parsed.value * post.magnitude, unit: pre.unit ?? post.unit, raw: span.slice(fullStart, fullEnd) })
    i = parsed.next
  }

  return hits.sort((a, b) => span.indexOf(a.raw) - span.indexOf(b.raw))
}

// ── numeralDerivable / verifyNumericFact ────────────────────────────────────────────────────────

const REL_EPSILON = 1e-9

function approxEqual(a: number, b: number): boolean {
  if (a === b) return true
  const scale = Math.max(Math.abs(a), Math.abs(b), 1)
  return Math.abs(a - b) <= REL_EPSILON * scale
}

/** True iff `value` (within 1e-9 relative epsilon) equals some NumeralHit.value in span,
 *  and, when `unit` is provided, that hit's unit matches (null hit unit matches only null/undefined expected unit). */
export function numeralDerivable(value: number, span: string, unit?: string): boolean {
  return extractNumerals(span).some((h) => {
    if (!approxEqual(h.value, value)) return false
    if (h.unit === null) return unit === undefined || unit === null
    return h.unit === unit
  })
}

export type NumericFactInput = { value: number; quote: string; unit?: string }

/** 'verified' iff ALL THREE hold: (a) alignQuote(fact.quote, transcript) succeeds,
 *  (b) numeralDerivable(fact.value, fact.quote, fact.unit) — the value is claimed by the QUOTE itself,
 *  (c) numeralDerivable(fact.value, matchedSpan, fact.unit) — AND stated in the aligned transcript span.
 *  (b) stops the fuzzy aligner from sweeping a stray interior transcript numeral into the claim;
 *  (c) stops a fuzzy match from verifying a quote whose number drifted from what was actually said.
 *
 *  What "verified" asserts — and does NOT assert: this proves the value is stated verbatim in the
 *  transcript at the aligned quote's location, nothing more. If the same numeral is also said elsewhere
 *  in a rejected/superseded sense ("approved at 300k, not the 500k we hoped for"), a quote that aligns
 *  to the 300k region can never verify a claimed 500k — rule (c) only accepts a value derivable from
 *  that single contiguous aligned span, not the whole transcript. But if a claim's quote itself aligns
 *  right next to a DIFFERENT number in the same breath, deterministic substring matching cannot tell
 *  "this is the number that was decided" from "this is a number that was also mentioned nearby" — that
 *  is a semantic judgment outside this module's scope, not something fail-closed parsing can solve. */
export function verifyNumericFact(fact: NumericFactInput, transcript: string): 'verified' | 'unverified' {
  const match = alignQuote(fact.quote, transcript)
  if (!match) return 'unverified'
  if (!numeralDerivable(fact.value, fact.quote, fact.unit)) return 'unverified'
  // Slice the SAME folded string alignQuote computed match.start/end against (both alignQuote's exact
  // and fuzzy paths operate on `foldCase(transcript)`, never on `transcript` itself). Slicing the raw
  // transcript here would misalign whenever folding changes length before the match — e.g. a ligature
  // ('ﬁ' -> 'fi') earlier in the transcript — silently reading the wrong region for rule (c).
  const span = foldCase(transcript).slice(match.start, match.end)
  return numeralDerivable(fact.value, span, fact.unit) ? 'verified' : 'unverified'
}
