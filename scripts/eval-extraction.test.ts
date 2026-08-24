import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizeKey, scoreCategory, scoreExtraction, formatReport, runEval, toScorable } from './eval-extraction.mjs'

const temporaryRoots: string[] = []
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('normalizeKey', () => {
  it('folds case, collapses whitespace, and strips diacritics so phonetic-confusion spellings collide', () => {
    expect(normalizeKey("L'Oréal")).toBe(normalizeKey("L'Oreal"))
    expect(normalizeKey('Société Générale')).toBe(normalizeKey('Societe Generale'))
    expect(normalizeKey('  Sarah   Chen ')).toBe(normalizeKey('sarah chen'))
  })
})

describe('scoreCategory', () => {
  it('perfect match: precision and recall both 1, zero fp/fn', () => {
    const golden = { m1: { people: [{ name: 'Sarah Chen' }, { name: 'James Walsh' }] } }
    const actual = { m1: { people: [{ name: 'Sarah Chen' }, { name: 'James Walsh' }] } }
    const r = scoreCategory(golden, actual, 'people', (p: Record<string, string>) => normalizeKey(p.name))
    expect(r).toEqual({ tp: 2, fp: 0, fn: 0, precision: 1, recall: 1 })
  })

  it('one miss (false negative): recall drops, precision stays perfect', () => {
    const golden = { m1: { people: [{ name: 'Sarah Chen' }, { name: 'James Walsh' }] } }
    const actual = { m1: { people: [{ name: 'Sarah Chen' }] } } // James Walsh missed
    const r = scoreCategory(golden, actual, 'people', (p: Record<string, string>) => normalizeKey(p.name))
    expect(r.tp).toBe(1)
    expect(r.fp).toBe(0)
    expect(r.fn).toBe(1)
    expect(r.precision).toBe(1)
    expect(r.recall).toBeCloseTo(0.5)
  })

  it('one hallucination (false positive): precision drops, recall stays perfect', () => {
    const golden = { m1: { people: [{ name: 'Sarah Chen' }] } }
    const actual = { m1: { people: [{ name: 'Sarah Chen' }, { name: 'Nonexistent Person' }] } }
    const r = scoreCategory(golden, actual, 'people', (p: Record<string, string>) => normalizeKey(p.name))
    expect(r.tp).toBe(1)
    expect(r.fp).toBe(1)
    expect(r.fn).toBe(0)
    expect(r.precision).toBeCloseTo(0.5)
    expect(r.recall).toBe(1)
  })

  it('a meeting with no actual output at all counts every golden item as a miss', () => {
    const golden = { m1: { people: [{ name: 'Sarah Chen' }] } }
    const actual = { m1: {} }
    const r = scoreCategory(golden, actual, 'people', (p: Record<string, string>) => normalizeKey(p.name))
    expect(r).toEqual({ tp: 0, fp: 0, fn: 1, precision: 1, recall: 0 })
  })

  it('phonetic-confusion spellings still count as a match after normalization', () => {
    const golden = { m1: { accounts: [{ name: "L'Oréal" }] } }
    const actual = { m1: { accounts: [{ name: "L'Oreal" }] } }
    const r = scoreCategory(golden, actual, 'accounts', (a) => normalizeKey(a.name))
    expect(r).toEqual({ tp: 1, fp: 0, fn: 0, precision: 1, recall: 1 })
  })

  it('numeric_facts match by kind+value+unit, not text', () => {
    const key = (f: { kind: string; value: number; unit: string | null }) =>
      `${f.kind}|${f.value}|${f.unit ?? ''}`
    const golden = { m1: { numeric_facts: [{ kind: 'amount', value: 3500000, unit: 'EUR' }] } }
    const actualMatch = { m1: { numeric_facts: [{ kind: 'amount', value: 3500000, unit: 'EUR' }] } }
    const actualWrongUnit = { m1: { numeric_facts: [{ kind: 'amount', value: 3500000, unit: 'USD' }] } }
    expect(scoreCategory(golden, actualMatch, 'numeric_facts', key)).toEqual({ tp: 1, fp: 0, fn: 0, precision: 1, recall: 1 })
    const wrong = scoreCategory(golden, actualWrongUnit, 'numeric_facts', key)
    expect(wrong.tp).toBe(0)
    expect(wrong.fp).toBe(1)
    expect(wrong.fn).toBe(1)
  })
})

describe('scoreExtraction', () => {
  it('produces one row per category plus a combined TOTAL row', () => {
    const golden = {
      m1: {
        people: [{ name: 'Sarah Chen' }],
        accounts: [{ name: 'Acme Bank' }],
        deals: [{ name: 'Acme Core Banking' }],
        numeric_facts: [{ kind: 'amount', value: 100, unit: null }],
        commitments: [{ text: 'send the pack' }]
      }
    }
    const actual = {
      m1: {
        people: [{ name: 'Sarah Chen' }],
        accounts: [],
        deals: [{ name: 'Acme Core Banking' }, { name: 'Hallucinated Deal' }],
        numeric_facts: [{ kind: 'amount', value: 100, unit: null }],
        commitments: [{ text: 'send the pack' }]
      }
    }
    const rows = scoreExtraction(golden, actual)
    const byCategory = Object.fromEntries(rows.map((r) => [r.category, r]))
    expect(byCategory.people).toMatchObject({ tp: 1, fp: 0, fn: 0 })
    expect(byCategory.accounts).toMatchObject({ tp: 0, fp: 0, fn: 1 })
    expect(byCategory.deals).toMatchObject({ tp: 1, fp: 1, fn: 0 })
    expect(byCategory.TOTAL.tp).toBe(4) // people(1) + deals(1) + numeric_facts(1) + commitments(1)
    expect(byCategory.TOTAL.fp).toBe(1)
    expect(byCategory.TOTAL.fn).toBe(1)
  })
})

describe('formatReport', () => {
  it('renders a header row plus one line per scored row', () => {
    const rows = scoreExtraction({}, {})
    const text = formatReport(rows)
    const lines = text.split('\n')
    expect(lines[0]).toBe('category\tprecision\trecall\ttp\tfp\tfn')
    expect(lines).toHaveLength(rows.length + 1)
    expect(lines.at(-1)?.startsWith('TOTAL\t')).toBe(true)
  })
})

describe('toScorable (Task MI-4 — adapts a real MeetingExtraction into the golden comparison shape)', () => {
  it('maps the singular nullable account/deal into the golden flat/plural arrays', () => {
    const extraction = {
      people: [{ name: 'Sarah Chen', role: 'CFO', org: 'Acme Bank', confidence: 'EXTRACTED' }],
      account: { name: 'Acme Bank', sector: 'banking', sector_confidence: 'EXTRACTED', confidence: 'EXTRACTED' },
      deal: { name: 'Acme Core Banking Migration', stage: 'negotiation', win_likelihood_band: null, band_evidence: '', velocity: { signal: 'no-hard-date-found', evidence: '' } },
      numeric_facts: [{ kind: 'amount', value: 2_400_000, unit: 'EUR', quote: 'the total contract value comes in at 2.4M EUR', confidence: 'EXTRACTED' }],
      commitments: [{ text: 'send over the updated security pack', by: 'you', due_hint: '', quote: '', confidence: 'EXTRACTED' }]
    }
    expect(toScorable(extraction)).toEqual({
      people: [{ name: 'Sarah Chen', role: 'CFO', org: 'Acme Bank' }],
      accounts: [{ name: 'Acme Bank', sector: 'banking' }],
      deals: [{ name: 'Acme Core Banking Migration', account: 'Acme Bank', stage: 'negotiation' }],
      numeric_facts: [{ kind: 'amount', value: 2_400_000, unit: 'EUR', quote: 'the total contract value comes in at 2.4M EUR' }],
      commitments: [{ text: 'send over the updated security pack', by: 'you' }]
    })
  })

  it('a null account/deal maps to empty arrays, never a fabricated entry', () => {
    expect(toScorable({ people: [], account: null, deal: null, numeric_facts: [], commitments: [] })).toEqual({
      people: [],
      accounts: [],
      deals: [],
      numeric_facts: [],
      commitments: []
    })
  })

  it('is defensive against a missing/undefined extraction (matches the pre-existing "no actual file" contract)', () => {
    expect(toScorable(undefined)).toEqual({ people: [], accounts: [], deals: [], numeric_facts: [], commitments: [] })
    expect(toScorable({})).toEqual({ people: [], accounts: [], deals: [], numeric_facts: [], commitments: [] })
  })
})

describe('runEval (reads real golden + actual directories)', () => {
  it('scores a REAL MeetingExtraction-shaped actual file (singular account/deal) against a golden-dir on disk, missing actual files count as full misses', async () => {
    const goldenDir = await mkdtemp(join(tmpdir(), 'eval-golden-'))
    const actualDir = await mkdtemp(join(tmpdir(), 'eval-actual-'))
    temporaryRoots.push(goldenDir, actualDir)

    const expected = {
      people: [{ name: 'Sarah Chen', role: 'CFO', org: 'Acme' }],
      accounts: [{ name: 'Acme', sector: 'banking' }],
      deals: [],
      numeric_facts: [{ kind: 'amount', value: 100, unit: null, quote: 'a hundred units' }],
      commitments: []
    }
    await writeFile(join(goldenDir, '01-acme.expected.json'), JSON.stringify(expected))
    await writeFile(join(goldenDir, '01-acme.md'), '# Acme\n\na hundred units\n')
    // 02-noactual has a golden entry but no matching actual output at all.
    await writeFile(
      join(goldenDir, '02-noactual.expected.json'),
      JSON.stringify({ people: [{ name: 'Nobody Here' }], accounts: [], deals: [], numeric_facts: [], commitments: [] })
    )

    // The `.brain/meetings/<slug>.json` shape ingestExtraction actually writes — singular nullable
    // account/deal, not the golden's flat plural arrays — this is the real contract runEval must score.
    const realExtraction = {
      schema_version: 2,
      people: [{ name: 'Sarah Chen', role: 'CFO', org: 'Acme', confidence: 'EXTRACTED' }],
      account: { name: 'Acme', sector: 'banking', sector_confidence: 'EXTRACTED', confidence: 'EXTRACTED' },
      deal: null,
      numeric_facts: [{ kind: 'amount', value: 100, unit: null, quote: 'a hundred units', confidence: 'EXTRACTED' }],
      commitments: []
    }
    await writeFile(join(actualDir, '01-acme.json'), JSON.stringify(realExtraction))

    const rows = runEval(actualDir, goldenDir)
    const byCategory = Object.fromEntries(rows.map((r) => [r.category, r]))
    expect(byCategory.people).toMatchObject({ tp: 1, fp: 0, fn: 1 }) // Sarah Chen hit, Nobody Here missed
    expect(byCategory.accounts).toMatchObject({ tp: 1, fp: 0, fn: 0 })
    expect(byCategory.numeric_facts).toMatchObject({ tp: 1, fp: 0, fn: 0 })
  })

  it('always reports (never throws) when actual-dir has no file at all for a golden slug', async () => {
    const goldenDir = await mkdtemp(join(tmpdir(), 'eval-golden-'))
    const actualDir = await mkdtemp(join(tmpdir(), 'eval-actual-'))
    temporaryRoots.push(goldenDir, actualDir)
    await writeFile(
      join(goldenDir, 'only.expected.json'),
      JSON.stringify({ people: [{ name: 'X' }], accounts: [], deals: [], numeric_facts: [], commitments: [] })
    )
    expect(() => runEval(actualDir, goldenDir)).not.toThrow()
  })
})
