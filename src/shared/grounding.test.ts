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

  it('French number words incl. soixante-dix / quatre-vingt / quatre-vingt-dix', () => {
    expect(vals('nous avons soixante-dix clients')).toContainEqual({ value: 70, unit: null })
    expect(vals('nous avons quatre-vingts clients')).toContainEqual({ value: 80, unit: null })
    expect(vals('nous avons quatre-vingt-dix clients')).toContainEqual({ value: 90, unit: null })
    expect(vals('nous avons soixante-quinze clients')).toContainEqual({ value: 75, unit: null })
    expect(vals('une équipe de cent personnes')).toContainEqual({ value: 100, unit: null })
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
})
