import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { alignQuote, verifyNumericFact } from './grounding'

/**
 * Golden set — 12 synthetic meeting transcripts + hand-verified ground truth, under
 * `__fixtures__/golden/`. Three properties keep this set honest and prove the grounding
 * guarantee, forever:
 *   1. Every claimed `quote` really is in the transcript (a golden that lies about its own
 *      evidence would rot the whole measurement foundation).
 *   2. Every golden numeric_fact verifies against its own transcript (grounding.ts must accept
 *      the truth).
 *   3. Every PERTURBED numeric_fact (value/magnitude/unit tampered with) is rejected — 100% of
 *      the time, no sampling — which is the actual "no unverified number" guarantee.
 */

type NumericFact = { kind: 'amount' | 'percent' | 'date' | 'headcount'; value: number; unit: string | null; quote: string }
type GoldenExpected = {
  people: { name: string; role: string; org: string }[]
  accounts: { name: string; sector: string }[]
  deals: { name: string; account: string; stage: string }[]
  numeric_facts: NumericFact[]
  commitments: { text: string; by: string }[]
}

const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '__fixtures__/golden')

function loadGoldenSlugs(): string[] {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''))
    .sort()
}

function loadFixture(slug: string): { transcript: string; expected: GoldenExpected } {
  const transcript = readFileSync(join(FIXTURES_DIR, `${slug}.md`), 'utf8')
  const expected = JSON.parse(readFileSync(join(FIXTURES_DIR, `${slug}.expected.json`), 'utf8')) as GoldenExpected
  return { transcript, expected }
}

const slugs = loadGoldenSlugs()

describe('golden set — meta (keeps the goldens honest)', () => {
  it('found the full 12-fixture set (7 English, 3 French, 2 code-switched)', () => {
    expect(slugs.length).toBe(12)
  })

  it.each(slugs)('%s: every expected numeric_fact quote is a verbatim substring of its transcript', (slug) => {
    const { transcript, expected } = loadFixture(slug)
    expect(expected.numeric_facts.length).toBeGreaterThanOrEqual(2)
    for (const fact of expected.numeric_facts) {
      expect(transcript.includes(fact.quote), `quote not found verbatim: ${JSON.stringify(fact.quote)}`).toBe(true)
    }
  })
})

describe('golden set — verification (grounding.ts accepts the truth)', () => {
  it.each(slugs)('%s: every golden numeric_fact verifies against its transcript', (slug) => {
    const { transcript, expected } = loadFixture(slug)
    for (const fact of expected.numeric_facts) {
      const result = verifyNumericFact({ value: fact.value, quote: fact.quote, unit: fact.unit ?? undefined }, transcript)
      expect(result, `expected 'verified' for ${JSON.stringify(fact)}`).toBe('verified')
    }
  })
})

// ── adversarial perturbation suite ──────────────────────────────────────────────────────────────
// Deterministic, no sampling: EVERY golden numeric_fact gets three tampered variants. All three MUST
// come back 'unverified' — that is the actual proof of the "no unverified number" guarantee.

function neighborSwap(value: number): number {
  // Least-significant NONZERO-digit neighbor swap (e.g. 3_500_000 -> 3_600_000, 2026 -> 2027,
  // 1_200_000_000 -> 1_300_000_000). A flat "+1" would be swallowed by numeralDerivable's 1e-9
  // *relative* epsilon once a value gets into the hundreds-of-millions (diff of 1 is smaller than
  // 1e-9 * value at that scale) — bumping the digit that actually carries the figure's precision
  // is what "neighbor swap" has to mean for round business numbers, and it never round-trips
  // within the epsilon regardless of magnitude.
  if (!Number.isInteger(value) || value === 0) return value + 1
  const sign = value < 0 ? -1 : 1
  const abs = Math.abs(value)
  let scale = 1
  while (abs % (scale * 10) === 0) scale *= 10
  const digit = Math.floor(abs / scale) % 10
  const bumped = digit === 9 ? digit - 1 : digit + 1
  return sign * (abs - digit * scale + bumped * scale)
}

function magnitudeSwap(value: number): number {
  // Alternate ×1000 / ÷1000 so the perturbed value never coincidentally equals the original
  // (÷1000 of a value under 1000 would otherwise sometimes round-trip through non-integers safely,
  // but never collide with the original since ×1000 and ÷1000 are both != identity for value != 0).
  return value === 0 ? 1000 : value * 1000
}

function unitSwap(unit: string | null): string | undefined {
  if (unit === 'EUR') return 'USD'
  if (unit === 'USD') return 'EUR'
  if (unit === 'GBP') return 'EUR'
  if (unit === '%') return 'EUR'
  return 'EUR' // null/undefined -> attach a unit where none was verified (must not spuriously match)
}

const allFacts = slugs.flatMap((slug) => {
  const { transcript, expected } = loadFixture(slug)
  return expected.numeric_facts.map((fact) => ({ slug, transcript, fact }))
})

describe('golden set — adversarial perturbation (100% flag rate, no exceptions)', () => {
  it('sanity: the golden set has numeric facts to perturb', () => {
    expect(allFacts.length).toBeGreaterThan(0)
  })

  it.each(allFacts.map(({ slug, fact }) => `${slug}: ${fact.quote}`))(
    '%s — neighbor/magnitude/unit swaps are all rejected',
    (label) => {
      const entry = allFacts.find(({ slug, fact }) => `${slug}: ${fact.quote}` === label)!
      const { transcript, fact } = entry

      const neighbor = verifyNumericFact({ value: neighborSwap(fact.value), quote: fact.quote, unit: fact.unit ?? undefined }, transcript)
      expect(neighbor, 'neighbor-swap must be unverified').toBe('unverified')

      const magnitude = verifyNumericFact({ value: magnitudeSwap(fact.value), quote: fact.quote, unit: fact.unit ?? undefined }, transcript)
      expect(magnitude, 'magnitude-swap must be unverified').toBe('unverified')

      const unit = verifyNumericFact({ value: fact.value, quote: fact.quote, unit: unitSwap(fact.unit) }, transcript)
      expect(unit, 'unit-swap must be unverified').toBe('unverified')
    }
  )

  it('every perturbation across the whole golden set is unverified — 100%, counted', () => {
    let total = 0
    let flagged = 0
    for (const { transcript, fact } of allFacts) {
      const variants: { value: number; unit?: string }[] = [
        { value: neighborSwap(fact.value), unit: fact.unit ?? undefined },
        { value: magnitudeSwap(fact.value), unit: fact.unit ?? undefined },
        { value: fact.value, unit: unitSwap(fact.unit) }
      ]
      for (const v of variants) {
        total++
        if (verifyNumericFact({ value: v.value, quote: fact.quote, unit: v.unit }, transcript) === 'unverified') flagged++
      }
    }
    expect(total).toBeGreaterThan(0)
    expect(flagged).toBe(total) // 100% — no sampling, no exceptions
  })
})

// ── fuzzy-path robustness suite ─────────────────────────────────────────────────────────────────
// Real quotes arrive with ASR drift, so the guarantee must hold on the FUZZY path too — not just for
// verbatim quotes. Deterministic noise (no randomness, failures always reproduce): one filler word
// after the first word plus comma drift — a realistic single-utterance transcription wobble that must
// stay above the default 0.85 alignment threshold.

function injectAsrNoise(quote: string): string {
  const words = quote.replace(/,/g, '').split(' ')
  return [words[0], 'uh', ...words.slice(1)].join(' ')
}

describe('golden set — fuzzy-path robustness (noisy quotes verify, perturbations still 100% rejected)', () => {
  it.each(allFacts.map(({ slug, fact }) => `${slug}: ${fact.quote}`))(
    '%s — noisy quote verifies, all swaps rejected',
    (label) => {
      const { transcript, fact } = allFacts.find(({ slug, fact }) => `${slug}: ${fact.quote}` === label)!
      const noisy = injectAsrNoise(fact.quote)

      const m = alignQuote(noisy, transcript)
      expect(m, 'noisy quote must still align').not.toBeNull()
      expect(m!.score, 'noise must force the fuzzy path, not the exact one').toBeLessThan(1)

      const truth = verifyNumericFact({ value: fact.value, quote: noisy, unit: fact.unit ?? undefined }, transcript)
      expect(truth, 'true value must still verify through the fuzzy path').toBe('verified')

      const neighbor = verifyNumericFact({ value: neighborSwap(fact.value), quote: noisy, unit: fact.unit ?? undefined }, transcript)
      expect(neighbor, 'fuzzy neighbor-swap must be unverified').toBe('unverified')

      const magnitude = verifyNumericFact({ value: magnitudeSwap(fact.value), quote: noisy, unit: fact.unit ?? undefined }, transcript)
      expect(magnitude, 'fuzzy magnitude-swap must be unverified').toBe('unverified')

      const unit = verifyNumericFact({ value: fact.value, quote: noisy, unit: unitSwap(fact.unit) }, transcript)
      expect(unit, 'fuzzy unit-swap must be unverified').toBe('unverified')
    }
  )
})
