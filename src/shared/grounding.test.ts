import { describe, it, expect } from 'vitest'
import { alignQuote, extractNumerals, numeralDerivable, verifyNumericFact } from './grounding'

describe('alignQuote', () => {
  it('finds an exact quote via indexOf after normalization', () => {
    const transcript = 'Them: We think the deal will close by Friday. You: Great, thank you.'
    const m = alignQuote('the deal will close by Friday', transcript)
    expect(m).not.toBeNull()
    expect(transcript.slice(m!.start, m!.end).toLowerCase()).toContain('the deal will close by friday')
    expect(m!.score).toBe(1)
  })

  it('matches case-insensitively and across curly punctuation/whitespace reflow', () => {
    const transcript = 'Them: Our   Revenue\n grew  20 percent  this year.'
    const m = alignQuote('revenue grew 20 percent', transcript)
    expect(m).not.toBeNull()
  })

  it('returns null when the quote is not present at all', () => {
    const transcript = 'Them: We are happy with the current vendor and see no reason to switch.'
    expect(alignQuote('we plan to cancel the contract next week', transcript)).toBeNull()
  })

  it('returns null for a near-miss quote below threshold', () => {
    const transcript = 'Them: The quarterly forecast shows fifteen percent growth in the retail segment.'
    // Same shape, unrelated content words — should score low, not just "not exact".
    const near = 'the annual roadmap has several open risk items pending review'
    expect(alignQuote(near, transcript)).toBeNull()
  })

  it('ASR noise robustness: tolerates inserted filler words and punctuation drift via the fuzzy path', () => {
    const transcript = 'Them: uh we will, deliver the report by uh Friday for sure.'
    const m = alignQuote('we will deliver the report by Friday', transcript)
    expect(m).not.toBeNull()
    expect(m!.score).toBeGreaterThanOrEqual(0.85)
  })

  it('respects a custom, stricter threshold on a borderline fuzzy match', () => {
    const transcript = 'Them: uh we will, deliver the report by uh Friday for sure.'
    const m = alignQuote('we will deliver the report by Friday', transcript, 0.85)
    expect(m).not.toBeNull()
    // A threshold above the achieved score must reject the same match.
    expect(alignQuote('we will deliver the report by Friday', transcript, m!.score + 0.001)).toBeNull()
  })

  it('FIX 1: score 1.0 is reserved for a genuine verbatim contiguous match — a fuzzy window that had to absorb transcript-side filler scores strictly below 1', () => {
    // The exact path already claims any truly contiguous (post-normalization) match; reaching the
    // fuzzy path at all means the window is NOT a literal substring. Filler words interspersed in the
    // TRANSCRIPT (as opposed to the query) previously scored a false-perfect 1.0 because the old
    // formula (overlap / queryLength) never charged for extra tokens absorbed into the window.
    const transcript = 'Them: uh we will, deliver the report by uh Friday for sure.'
    const m = alignQuote('we will deliver the report by Friday', transcript)
    expect(m).not.toBeNull()
    expect(m!.score).toBeLessThan(1)
    expect(m!.score).toBeGreaterThanOrEqual(0.85)
  })
})

describe('extractNumerals', () => {
  const vals = (span: string): { value: number; unit: string | null }[] =>
    extractNumerals(span).map((h) => ({ value: h.value, unit: h.unit }))

  it('plain digit forms', () => {
    expect(vals('revenue was 1500 units')).toContainEqual({ value: 1500, unit: null })
  })

  it('comma thousands (English)', () => {
    expect(vals('revenue was 1,500 units')).toContainEqual({ value: 1500, unit: null })
  })

  it('narrow no-break space (U+202F) thousands grouping', () => {
    expect(vals('revenue was 1\u202f500 units')).toContainEqual({ value: 1500, unit: null })
  })

  it('ASCII space between digit runs is NOT grouping: two independent numerals, never a merged value', () => {
    const hits = vals('we shipped 20 200 units this week')
    expect(hits).toContainEqual({ value: 20, unit: null })
    expect(hits).toContainEqual({ value: 200, unit: null })
    expect(hits.some((h) => h.value === 20200)).toBe(false)
    expect(numeralDerivable(20200, 'we shipped 20 200 units this week')).toBe(false)
    // Same rule for the '1 500' form: the merged 1500 is never fabricated from an ASCII space.
    expect(vals('revenue was 1 500 units').some((h) => h.value === 1500)).toBe(false)
  })

  it('dot thousands (French convention, exactly 3 trailing digits)', () => {
    expect(vals('le chiffre est 1.500 unités')).toContainEqual({ value: 1500, unit: null })
  })

  it('English decimal with dot', () => {
    expect(vals('growth of 3.5 percent')).toContainEqual({ value: 3.5, unit: '%' })
  })

  it('French decimal with comma', () => {
    expect(vals('une croissance de 3,5 pour cent')).toContainEqual({ value: 3.5, unit: '%' })
  })

  it('magnitude suffix letters: k, M, bn/B, mio', () => {
    expect(vals('budget of 200k')).toContainEqual({ value: 200_000, unit: null })
    expect(vals('valued at 3.5M')).toContainEqual({ value: 3_500_000, unit: null })
    expect(vals('raised 1.2bn')).toContainEqual({ value: 1_200_000_000, unit: null })
    expect(vals('raised 1.2B')).toContainEqual({ value: 1_200_000_000, unit: null })
    expect(vals('worth 4 mio')).toContainEqual({ value: 4_000_000, unit: null })
  })

  it('English magnitude words: thousand, million, billion', () => {
    expect(vals('a market of 2 million users')).toContainEqual({ value: 2_000_000, unit: null })
    expect(vals('cost 15 thousand EUR')).toContainEqual({ value: 15_000, unit: 'EUR' })
    expect(vals('worth 1 billion')).toContainEqual({ value: 1_000_000_000, unit: null })
  })

  it('English decimal phrasing: "three point five million"', () => {
    expect(vals('valued at three point five million')).toContainEqual({ value: 3_500_000, unit: null })
  })

  it('English number words: units, teens, tens, hundred', () => {
    expect(vals('we have fifteen open deals')).toContainEqual({ value: 15, unit: null })
    expect(vals('we have twenty-three clients')).toContainEqual({ value: 23, unit: null })
    expect(vals('a team of two hundred people')).toContainEqual({ value: 200, unit: null })
  })

  it('FIX 3: multiplier compounds ("N hundred"/"N cent(s)") never emit the leading multiplicand as a standalone hit', () => {
    // English: a full tens/units phrase before "hundred" ("twenty-five hundred" = 2500), not just a
    // bare unit word — the old parser only recognized "hundred" after a SINGLE unit word.
    const twentyFiveHundred = vals('twenty-five hundred')
    expect(twentyFiveHundred).toContainEqual({ value: 2500, unit: null })
    expect(twentyFiveHundred.some((h) => h.value === 25)).toBe(false)
    // Bare "hundred" alone = 100.
    expect(vals('a hundred clients')).toContainEqual({ value: 100, unit: null })

    // French: plural "cents" (used when nothing follows) must trigger the ×100 multiplier just like
    // singular "cent" already does — the old parser only recognized the singular form.
    const deuxCents = vals('deux cents')
    expect(deuxCents).toContainEqual({ value: 200, unit: null })
    expect(deuxCents.some((h) => h.value === 2)).toBe(false)
    // "cent"/"cents" chains through to a further magnitude word: "cinq cents mille" = 500,000.
    const cinqCentsMille = vals('cinq cents mille')
    expect(cinqCentsMille).toContainEqual({ value: 500_000, unit: null })
    expect(cinqCentsMille.some((h) => h.value === 5)).toBe(false)
    expect(cinqCentsMille.some((h) => h.value === 500)).toBe(false)
  })

  it('French number words incl. soixante-dix / quatre-vingt / quatre-vingt-dix', () => {
    expect(vals('nous avons soixante-dix clients')).toContainEqual({ value: 70, unit: null })
    expect(vals('nous avons quatre-vingts clients')).toContainEqual({ value: 80, unit: null })
    expect(vals('nous avons quatre-vingt-dix clients')).toContainEqual({ value: 90, unit: null })
    expect(vals('nous avons soixante-quinze clients')).toContainEqual({ value: 75, unit: null })
    expect(vals('une équipe de cent personnes')).toContainEqual({ value: 100, unit: null })
  })

  it('FIX 2: French compound numbers never fragment — "soixante et onze" (71) is the sole exception in the 70s needing "et"', () => {
    // 71 is the ONLY standard written form using "et" in the 70s/80s/90s range — everything else
    // (72-79, 80-99) compounds directly. Before the fix, "soixante et onze" fragmented into 60 + 11.
    const hits = vals('soixante et onze pour cent')
    expect(hits).toContainEqual({ value: 71, unit: '%' })
    expect(hits.some((h) => h.value === 60)).toBe(false)
    expect(hits.some((h) => h.value === 11)).toBe(false)
    // Regression coverage for the rest of the 70-99 family (already correct, must stay correct).
    expect(vals('quatre-vingt-onze clients')).toContainEqual({ value: 91, unit: null })
    expect(vals('soixante-douze clients')).toContainEqual({ value: 72, unit: null })
    expect(vals('quatre-vingt-un clients')).toContainEqual({ value: 81, unit: null })
    expect(vals('quatre-vingts clients')).toContainEqual({ value: 80, unit: null })
  })

  it('French virgule decimals: "trois virgule cinq millions"', () => {
    // Currency scope is symbols/codes (€, $, £, EUR, USD, GBP) — not currency words like "euros".
    expect(vals('le marché vaut trois virgule cinq millions EUR')).toContainEqual({ value: 3_500_000, unit: 'EUR' })
  })

  it('French "et demi": "un million et demi" = 1_500_000', () => {
    expect(vals('un budget de un million et demi')).toContainEqual({ value: 1_500_000, unit: null })
  })

  it('currency symbols and codes, prefix or suffix', () => {
    expect(vals('valued at €3.5M')).toContainEqual({ value: 3_500_000, unit: 'EUR' })
    expect(vals('worth 3,5 M€')).toContainEqual({ value: 3_500_000, unit: 'EUR' })
    expect(vals('budget of USD 200k')).toContainEqual({ value: 200_000, unit: 'USD' })
    expect(vals('priced at $150')).toContainEqual({ value: 150, unit: 'USD' })
    expect(vals('worth £2M')).toContainEqual({ value: 2_000_000, unit: 'GBP' })
  })

  it('percent forms: %, percent, pour cent', () => {
    expect(vals('grew 12%')).toContainEqual({ value: 12, unit: '%' })
    expect(vals('grew 12 percent')).toContainEqual({ value: 12, unit: '%' })
    expect(vals('a progressé de 12 pour cent')).toContainEqual({ value: 12, unit: '%' })
  })

  it('does not treat the French indefinite article "un/une" as a numeral in ordinary prose', () => {
    // "un client important" — "un" here is "a client", not the number 1. Fail closed: no hit.
    expect(vals('un client important nous a contactés')).toEqual([])
    expect(vals('une réunion productive avec une cliente')).toEqual([])
  })

  it('FIX 4: NFKC compatibility decomposition never fabricates a digit the source did not state', () => {
    // '½' NFKC-folds to "1⁄2" (digit ONE, fraction slash, digit TWO) — neither digit was ever written
    // in the source. Fail closed: no hit at all (rather than fabricating 1 and/or 2).
    const half = extractNumerals('reduced by ½')
    expect(half.some((h) => h.value === 1)).toBe(false)
    expect(half.some((h) => h.value === 2)).toBe(false)

    // '²' NFKC-folds to '2', AND the 'm' immediately before it is the area-unit "meters", not the
    // magnitude LETTER for "million" — must read as bare 50, never fabricate a stray 2, and never
    // misread "50m²" as 50 million.
    const m2 = vals('50m²')
    expect(m2).toContainEqual({ value: 50, unit: null })
    expect(m2.some((h) => h.value === 2)).toBe(false)
    expect(m2.some((h) => h.value === 50_000_000)).toBe(false)

    // A fraction glyph sitting between a digit and a magnitude word must not let them combine into a
    // fabricated product ("3½ million" must never yield 31 or 2,000,000 — the values NFKC-folding
    // would otherwise manufacture from the exploded fraction).
    const threeHalfMillion = extractNumerals('3½ million')
    expect(threeHalfMillion.some((h) => h.value === 31)).toBe(false)
    expect(threeHalfMillion.some((h) => h.value === 2_000_000)).toBe(false)
  })

  it('FIX 4b: a superscript-square unit with an SI PREFIX ("50km²") must not strand the prefix into a fabricated magnitude', () => {
    // Neutralizing only the '²' would leave "50k", and that 'k' then reads as a ×1000 magnitude
    // suffix — fabricating 50,000, a WORSE lie than the bare '2' the raw superscript would produce.
    // The WHOLE unit token (letter-run + superscript) must be blanked: '50km²' -> 50, never 50000.
    const km2 = vals('50km²')
    expect(km2).toContainEqual({ value: 50, unit: null })
    expect(km2.some((h) => h.value === 50_000)).toBe(false)

    // Same for a mega-prefix and a cube: '50Mm²' -> 50 (never 50,000,000), '50km³' -> 50 (never 50,000).
    expect(vals('50Mm²').some((h) => h.value === 50_000_000)).toBe(false)
    expect(vals('50Mm²')).toContainEqual({ value: 50, unit: null })
    expect(vals('50km³').some((h) => h.value === 50_000)).toBe(false)
    expect(vals('50km³')).toContainEqual({ value: 50, unit: null })

    // The precomposed square-km glyph '㎢' (NFKC -> "km2") is blanked the same way: '50㎢' -> 50.
    expect(vals('50㎢')).toContainEqual({ value: 50, unit: null })
    expect(vals('50㎢').some((h) => h.value === 50_000)).toBe(false)

    // Regression guard: a REAL magnitude letter ('k' NOT followed by a superscript) is untouched.
    expect(vals('50k EUR')).toContainEqual({ value: 50_000, unit: 'EUR' })
    // And a bare superscript with no preceding letters ('3²') fails closed to just 3, not 9 or 32.
    const bareSup = vals('3²')
    expect(bareSup).toContainEqual({ value: 3, unit: null })
    expect(bareSup.some((h) => h.value === 9 || h.value === 32 || h.value === 2)).toBe(false)
  })

  it('FIX 4c: enclosed-alphanumerics ("①", "⑴") are list bullets — never fabricate a digit and never skew offsets', () => {
    // '①' NFKC-folds to '1', '②' to '2' — list markers, not stated numeric values. Fail closed: no hit.
    const bullets = extractNumerals('grow ① cut ②')
    expect(bullets.some((h) => h.value === 1)).toBe(false)
    expect(bullets.some((h) => h.value === 2)).toBe(false)
    // '⑴' NFKC-decomposes to the 3-char "(1)" — both a fabricated 1 AND a length change that would skew
    // every downstream offset. Neutralized to a single space BEFORE folding: no hit, no skew.
    expect(extractNumerals('point ⑴ here').some((h) => h.value === 1)).toBe(false)
  })

  it('FIX 4d: circled numbers in the SIBLING enclosed blocks (㉑–㊿ CJK, 🄀–🄊 supplement) also fabricate nothing', () => {
    // U+3200–U+32FF (Enclosed CJK Letters/Months): '㊿' NFKC-folds to "50", '㉑' to "21" — decorative
    // markers, never a stated numeric value. Fail closed: no hit.
    expect(extractNumerals('reached ㊿ percent').some((h) => h.value === 50)).toBe(false)
    expect(vals('reached ㊿ percent')).toEqual([])
    expect(extractNumerals('item ㉑ on the list').some((h) => h.value === 21)).toBe(false)
    // U+1F100–U+1F1FF (Enclosed Alphanumeric Supplement, an ASTRAL block): '🄀' folds to "0." — must
    // not fabricate 0, and its 2-code-unit width must not skew later offsets (blanked to 2 spaces).
    expect(extractNumerals('bullet 🄀 first').some((h) => h.value === 0)).toBe(false)

    // Regression guard: legitimately-authored digit characters stay parseable.
    // Fullwidth '５０' (U+FF10–U+FF19) NFKC-folds to ASCII 50 — a real stated value, must survive.
    expect(vals('sales of ５０ units')).toContainEqual({ value: 50, unit: null })
    // Mathematical bold '𝟓𝟎' (U+1D7CE–U+1D7FF) likewise folds to 50 and must stay parseable.
    expect(extractNumerals('sales of 𝟓𝟎 units').some((h) => h.value === 50)).toBe(true)
  })

  it('is fail-closed on an unsupported grouping (not a clean run of 3-digit groups): no fabricated hit', () => {
    // "12,34,567" is not a valid thousands grouping (middle group is 2 digits, not 3) — out of the
    // documented scope. Must not silently invent 1234567 (or any other value) from it.
    const hits = extractNumerals('some odd figure like 12,34,567 shown once')
    expect(hits.some((h) => h.value === 1234567)).toBe(false)
  })
})

describe('numeralDerivable', () => {
  it('true when the value matches a hit in the span within epsilon', () => {
    expect(numeralDerivable(3_500_000, 'the deal is worth 3.5M')).toBe(true)
    expect(numeralDerivable(3.5 * 1_000_000, 'the deal is worth €3.5M', 'EUR')).toBe(true)
  })

  it('false for a numeric-neighbor swap', () => {
    expect(numeralDerivable(3_400_000, 'the deal is worth 3.5M')).toBe(false)
  })

  it('false for a magnitude swap', () => {
    expect(numeralDerivable(200_000_000, 'the budget is 200k')).toBe(false)
  })

  it('false for a unit swap', () => {
    expect(numeralDerivable(2_000_000, 'valued at €2M', 'USD')).toBe(false)
  })

  it('a null-unit hit only matches when no unit is expected', () => {
    expect(numeralDerivable(1500, '1500 units shipped')).toBe(true)
    expect(numeralDerivable(1500, '1500 units shipped', 'EUR')).toBe(false)
  })
})

describe('verifyNumericFact', () => {
  const transcript =
    'Them: The deal is worth about 3.5M EUR, and we saw 20% growth. ' +
    'They also mentioned an unrelated figure of 3,400,000 USD for a different project. ' +
    'You: Great, thanks for sharing.'

  it('verified when quote aligns and value is derivable from the matched span', () => {
    const fact = { value: 3_500_000, quote: 'The deal is worth about 3.5M EUR', unit: 'EUR' }
    expect(verifyNumericFact(fact, transcript)).toBe('verified')
  })

  it('unverified when the quote does not align', () => {
    const fact = { value: 3_500_000, quote: 'We are cancelling the contract entirely', unit: 'EUR' }
    expect(verifyNumericFact(fact, transcript)).toBe('unverified')
  })

  it('unverified: value present elsewhere in the transcript but NOT inside the aligned quote span', () => {
    // 3,400,000 really is in the transcript, but not inside THIS quote's span.
    const fact = { value: 3_400_000, quote: 'The deal is worth about 3.5M EUR', unit: 'USD' }
    expect(verifyNumericFact(fact, transcript)).toBe('unverified')
  })

  it('unverified for a numeric-neighbor swap against the aligned span', () => {
    const fact = { value: 3_400_000, quote: 'The deal is worth about 3.5M EUR', unit: 'EUR' }
    expect(verifyNumericFact(fact, transcript)).toBe('unverified')
  })

  it('unverified for a magnitude swap against the aligned span', () => {
    const fact = { value: 3_500, quote: 'The deal is worth about 3.5M EUR', unit: 'EUR' }
    expect(verifyNumericFact(fact, transcript)).toBe('unverified')
  })

  it('unverified for a unit swap against the aligned span', () => {
    const fact = { value: 3_500_000, quote: 'The deal is worth about 3.5M EUR', unit: 'USD' }
    expect(verifyNumericFact(fact, transcript)).toBe('unverified')
  })

  it('unverified: the fuzzy aligner must not sweep an interior stray numeral into the claim', () => {
    // The transcript really contains "45" INSIDE the fuzzy-aligned window, but the quote never
    // claims it — a value absent from the quote text itself must never verify (fail closed).
    const t = 'Them: uh we will, deliver the report 45 by uh Friday for sure.'
    const quote = 'we will deliver the report by Friday'
    expect(alignQuote(quote, t)).not.toBeNull() // the quote itself genuinely aligns (fuzzy path)
    expect(verifyNumericFact({ value: 45, quote }, t)).toBe('unverified')
  })

  it('unverified: fuzzy match where the transcript states a different value than the quote claims', () => {
    const t = 'Them: uh the deal is worth about 3.4M EUR for sure.'
    const quote = 'the deal is worth about 3.5M EUR'
    const m = alignQuote(quote, t)
    expect(m).not.toBeNull() // close enough to align via the fuzzy path...
    expect(m!.score).toBeLessThan(1)
    // ...but the transcript says 3.4M, so the quoted 3.5M must not verify.
    expect(verifyNumericFact({ value: 3_500_000, quote, unit: 'EUR' }, t)).toBe('unverified')
  })

  it('FIX 1 (CRITICAL): a short quote must not achieve a perfect fuzzy score by sweeping in a nearby DIFFERENT number', () => {
    // The transcript genuinely says 300k, then separately mentions 500k. A quote claiming "the budget
    // is 500k" is not a verbatim contiguous phrase anywhere in this transcript — before the fix, the
    // bounded slack still let the fuzzy window stretch just far enough to swallow "300k or" and reach
    // the literal "500k" token, scoring a false-perfect 1.0 and letting rule (c) trivially pass because
    // 500k was technically inside the (wrongly widened) span. Must fail closed: unverified.
    const t = 'Them: The budget is 300k or 500k depending on the scenario.'
    const quote = 'the budget is 500k'
    expect(verifyNumericFact({ value: 500_000, quote }, t)).toBe('unverified')
    // The true, actually-verbatim value for that same quote shape must still verify (regression).
    const trueT = 'Them: The budget is 300k for this phase, nothing else on the table.'
    expect(verifyNumericFact({ value: 300_000, quote: 'the budget is 300k' }, trueT)).toBe('verified')
  })

  it('FIX 2: claiming a French compound fragment (60 or 11) against a transcript stating 71 is unverified', () => {
    const t = 'Them: Le taux de résolution atteint soixante et onze pour cent ce trimestre.'
    const quote = 'Le taux de résolution atteint soixante et onze pour cent'
    expect(verifyNumericFact({ value: 71, quote, unit: '%' }, t)).toBe('verified')
    expect(verifyNumericFact({ value: 60, quote, unit: '%' }, t)).toBe('unverified')
    expect(verifyNumericFact({ value: 11, quote, unit: '%' }, t)).toBe('unverified')
  })

  it('FIX 3: claiming a multiplier-compound fragment (2 instead of 200) against a transcript stating "deux cents" is unverified', () => {
    const t = 'Them: Nous avons recruté deux cents nouveaux clients ce mois-ci.'
    const quote = 'Nous avons recruté deux cents nouveaux clients'
    expect(verifyNumericFact({ value: 200, quote }, t)).toBe('verified')
    expect(verifyNumericFact({ value: 2, quote }, t)).toBe('unverified')
  })

  it('FIX 4: claiming a NFKC-fabricated value (2, or 50000000) against a transcript stating "50m²" is unverified', () => {
    const t = 'Them: The new office covers 50m² on the top floor.'
    const quote = 'The new office covers 50m²'
    expect(verifyNumericFact({ value: 50, quote }, t)).toBe('verified')
    expect(verifyNumericFact({ value: 2, quote }, t)).toBe('unverified')
    expect(verifyNumericFact({ value: 50_000_000, quote }, t)).toBe('unverified')
  })

  it('FIX 4b: claiming the stranded-SI-prefix fabrication (50000) against "50km²" is unverified; the true 50 verifies', () => {
    const t = 'Them: The plant sits on 50km² of land near the coast.'
    const quote = 'The plant sits on 50km² of land'
    expect(verifyNumericFact({ value: 50, quote }, t)).toBe('verified')
    expect(verifyNumericFact({ value: 50_000, quote }, t)).toBe('unverified')
  })

  it('FIX 4c: claiming a bullet-marker value (1) near a "⑴"/"①" enclosed-alphanumeric is unverified', () => {
    const t = 'Them: Our two priorities are ⑴ grow revenue and ② cut cost this year.'
    expect(verifyNumericFact({ value: 1, quote: 'Our two priorities are ⑴ grow revenue' }, t)).toBe('unverified')
    expect(verifyNumericFact({ value: 2, quote: '② cut cost this year' }, t)).toBe('unverified')
  })

  it('FIX 4d: claiming a circled-number value (50) from a "㊿" in a sibling enclosed block is unverified', () => {
    const t = 'Them: adoption reached ㊿ percent across the pilot cohort.'
    const quote = 'adoption reached ㊿ percent'
    expect(verifyNumericFact({ value: 50, quote, unit: '%' }, t)).toBe('unverified')
  })

  it('FIX 5: a ligature/compat char earlier in the transcript must not shift rule (c)\'s span off the true quote', () => {
    // NFKC-decomposing 'ﬁ' -> 'fi' lengthens the FOLDED transcript by 1 char before the quoted region.
    // Slicing the ORIGINAL transcript at those folded-space indices reads a region shifted 1 char late —
    // here, dropping the quote's very first character (the leading '3' of "3.5M"), so the correctly
    // stated fact could no longer be confirmed at all (extractNumerals sees ".5M EUR", no leading
    // digit before the dot, and finds nothing to match against). Slicing the SAME folded string
    // alignQuote matched against keeps the span exactly aligned regardless of what precedes it.
    const t = 'Them: ﬁling complete. 3.5M EUR is the number everyone quoted today.'
    const fact = { value: 3_500_000, quote: '3.5M EUR', unit: 'EUR' }
    expect(verifyNumericFact(fact, t)).toBe('verified')
    // And the swap perturbations must still be correctly rejected on the (correctly sliced) span.
    expect(verifyNumericFact({ ...fact, value: 3_400_000 }, t)).toBe('unverified')
    expect(verifyNumericFact({ ...fact, unit: 'USD' }, t)).toBe('unverified')
  })
})
