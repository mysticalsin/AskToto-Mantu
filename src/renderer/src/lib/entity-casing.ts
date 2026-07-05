/**
 * ASR entity-casing bias — the SAFE version.
 *
 * Rewrites a transcript line so names the user's brain already knows (people, accounts — see
 * brain:entityNames in main/index.ts) render with their canonical spelling/casing, e.g. "l'oreal" ->
 * "L'Oréal", "mantu" -> "Mantu", "marc bisiou" -> "Marc Bisiou".
 *
 * HARD SAFETY RULES (deliberately NOT fuzzy/phonetic):
 *  - Only EXACT matches after lowercase + NFKD-diacritic-strip normalization. No Levenshtein/soundalike
 *    matching — a phonetic guess that rewrites "mark" (the verb) into a person named "Marc" would
 *    corrupt the transcript, which is worse than leaving a name mis-cased.
 *  - Names shorter than 3 characters are never auto-corrected (too likely to collide with a common word).
 *  - Whole-word only: matching "mark" must never fire on "marked" or "marking".
 *  - Multi-word names ("Marc Bisiou") match only as the full contiguous phrase, never a lone word from it.
 *  - Longer names win over shorter ones a longer name contains (e.g. "Example Account Alpha" beats
 *    "Example") — candidates are tried longest-first and a match claims its span so nothing shorter can
 *    re-match inside it.
 *  - A match that's already byte-identical to the canonical form is left untouched (no-op).
 */

interface EntityCasingCandidate {
  /** Matches against the NORMALIZED (folded) text — see buildNormalizedMap. */
  re: RegExp
  /** The original-cased/accented name to substitute in on a match. */
  canonical: string
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Lowercase + strip combining diacritics (NFKD decomposition, then drop the combining-mark block). */
function foldForMatch(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

/**
 * Builds a case/diacritic-folded copy of `text` alongside a per-character map back to the ORIGINAL
 * text's index, so a match found in the folded string can still be spliced into the real text at the
 * right byte offsets. `text` is NFC-normalized first so a rare NFD-decomposed input (base letter +
 * combining mark as two separate codepoints) can't leave a stray combining mark stranded past a
 * replacement's boundary — NFC is idempotent on the overwhelmingly common already-composed case, so this
 * is a no-op for normal ASR output.
 */
function buildNormalizedMap(rawText: string): { text: string; normalized: string; map: number[] } {
  const text = rawText.normalize('NFC')
  const map: number[] = []
  let normalized = ''
  let origIdx = 0
  for (const cp of text) {
    // for..of walks by Unicode codepoint (handles surrogate pairs), so cp.length is 1 or 2 UTF-16 units.
    const stripped = foldForMatch(cp)
    for (const ch of stripped) {
      normalized += ch
      map.push(origIdx)
    }
    origIdx += cp.length
  }
  map.push(origIdx) // sentinel: original index right after the last codepoint, for an end-of-match lookup
  return { text, normalized, map }
}

/**
 * Precompiles canonical entity names into matchers, longest-name-first so a longer name always wins over
 * a shorter one it contains. Filters out names under 3 characters and exact duplicates (by folded form).
 * Exported so callers (useListen) can compile once per entityNames change instead of per transcribed line
 * — the same idiom listen.ts already uses for asrCorrections' correctionsRef.
 */
export function compileEntityCasingCandidates(names: string[]): EntityCasingCandidate[] {
  const seen = new Set<string>()
  const withFold: { name: string; folded: string }[] = []
  for (const raw of names) {
    const name = raw.trim()
    if (name.length < 3) continue
    const folded = foldForMatch(name)
    if (!folded.trim() || seen.has(folded)) continue
    seen.add(folded)
    withFold.push({ name, folded })
  }
  withFold.sort((a, b) => b.name.length - a.name.length) // longer canonical name wins
  return withFold.map(({ name, folded }) => {
    const words = folded.split(/\s+/).filter(Boolean).map(escapeRegExp)
    const pattern = words.join('\\s+') // tolerate variable whitespace between words of a multi-word name
    // Whole-word boundary via lookaround on "is this a letter/number" rather than \b, so an internal
    // apostrophe ("l'oreal") doesn't get misread as a word boundary.
    return { re: new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`, 'gu'), canonical: name }
  })
}

/** Applies precompiled candidates (see compileEntityCasingCandidates) to one transcript line. */
export function applyEntityCasingCompiled(candidates: EntityCasingCandidate[], text: string): string {
  if (!text || candidates.length === 0) return text
  const { text: working, normalized, map } = buildNormalizedMap(text)
  if (!normalized) return text

  const claimedNorm: Array<[number, number]> = [] // normalized-space spans already taken by a longer match
  const overlaps = (s: number, e: number): boolean => claimedNorm.some(([cs, ce]) => s < ce && e > cs)
  const claims: Array<{ origStart: number; origEnd: number; canonical: string }> = []

  for (const { re, canonical } of candidates) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(normalized))) {
      const mStart = m.index
      const mEnd = mStart + m[0].length
      if (m[0].length === 0) {
        re.lastIndex += 1 // never spin on a zero-width match
        continue
      }
      if (!overlaps(mStart, mEnd)) {
        const origStart = map[mStart]
        const origEnd = map[mEnd]
        const matched = working.slice(origStart, origEnd)
        if (matched !== canonical) claims.push({ origStart, origEnd, canonical })
        // Claim the span even on a no-op match so a shorter candidate can't re-match inside it.
        claimedNorm.push([mStart, mEnd])
      }
    }
  }

  if (claims.length === 0) return working
  claims.sort((a, b) => a.origStart - b.origStart)
  let out = ''
  let cursor = 0
  for (const c of claims) {
    out += working.slice(cursor, c.origStart) + c.canonical
    cursor = c.origEnd
  }
  out += working.slice(cursor)
  return out
}

/** Convenience one-shot form (compiles + applies) — the pure function used directly by unit tests. */
export function applyEntityCasing(names: string[], text: string): string {
  return applyEntityCasingCompiled(compileEntityCasingCandidates(names), text)
}
