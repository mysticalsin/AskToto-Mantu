#!/usr/bin/env node
/**
 * Offline extraction scorer — NOT wired into CI's LLM path. Deterministic comparison only: given a
 * directory of actual extraction outputs and the golden fixture directory (src/shared/__fixtures__/golden),
 * prints per-category precision/recall plus totals. Always exits 0 — it reports, it does not gate.
 *
 * Usage: node scripts/eval-extraction.mjs <actual-dir> <golden-dir>
 *   <actual-dir>  holds one `<slug>.json` per scored meeting — a REAL MeetingExtraction object, the
 *                 exact shape ingestExtraction persists to `.brain/meetings/<slug>.json` (schema_version,
 *                 title24, a singular nullable `account`/`deal`, `people`/`commitments`/`numeric_facts`
 *                 arrays, etc. — see src/shared/brain.ts's MeetingExtractionSchema). `toScorable()` below
 *                 adapts that real shape into the golden `expected.json`'s flat, plural comparison shape
 *                 (people/accounts/deals/numeric_facts/commitments) before scoring — Task MI-4 closed the
 *                 gap MI-0 left open (this script used to require actual-dir already pre-shaped like a
 *                 golden file, an interim contract nothing in the real pipeline ever produced).
 *   <golden-dir>  holds `<slug>.md` + `<slug>.expected.json` pairs (see src/shared/golden-set.test.ts).
 *
 * Only golden-labeled slugs are scored — an actual-dir entry with no golden counterpart has nothing
 * to compare against and is silently ignored, matching how a golden-set eval is meant to work.
 *
 * Standalone by design: no imports from src/ (this is an .mjs script like its siblings). Name matching
 * mirrors the normalization INTENT of `slugify()` in src/main/brain/store.ts (NFKD + diacritic-strip +
 * casefold) without that function's collision-hash/truncation machinery, which scoring doesn't need.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Casefold + diacritic-strip + collapse to a comparable key. Mirrors slugify()'s normalization
 *  intent (src/main/brain/store.ts) so "L'Oréal" and "L'Oreal" score as the same entity. */
export function normalizeKey(s) {
  return (s ?? '')
    .toString()
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // combining diacritical marks
    .replace(/\s+/g, ' ')
}

function numericFactKey(f) {
  const unit = f.unit === null || f.unit === undefined ? '' : f.unit
  return `${f.kind}|${f.value}|${unit}`
}

/** Multiset (counted) precision/recall for one category across all scored meetings: sums true
 *  positives/false positives/false negatives per meeting so duplicate items don't over- or
 *  under-count, then combines into a single precision/recall pair for the category. */
export function scoreCategory(goldenBySlug, actualBySlug, categoryKey, keyFn) {
  let tp = 0
  let fp = 0
  let fn = 0
  for (const slug of Object.keys(goldenBySlug)) {
    const goldenItems = (goldenBySlug[slug]?.[categoryKey] ?? []).map(keyFn)
    const actualItems = (actualBySlug[slug]?.[categoryKey] ?? []).map(keyFn)

    const goldenCounts = new Map()
    for (const k of goldenItems) goldenCounts.set(k, (goldenCounts.get(k) ?? 0) + 1)
    const actualCounts = new Map()
    for (const k of actualItems) actualCounts.set(k, (actualCounts.get(k) ?? 0) + 1)

    const keys = new Set([...goldenCounts.keys(), ...actualCounts.keys()])
    for (const k of keys) {
      const g = goldenCounts.get(k) ?? 0
      const a = actualCounts.get(k) ?? 0
      tp += Math.min(g, a)
      fn += Math.max(0, g - a)
      fp += Math.max(0, a - g)
    }
  }
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp)
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn)
  return { tp, fp, fn, precision, recall }
}

const CATEGORIES = [
  { key: 'people', keyFn: (p) => normalizeKey(p.name) },
  { key: 'accounts', keyFn: (a) => normalizeKey(a.name) },
  { key: 'deals', keyFn: (d) => normalizeKey(d.name) },
  { key: 'numeric_facts', keyFn: numericFactKey },
  { key: 'commitments', keyFn: (c) => normalizeKey(c.text) }
]

/** Score every category across the golden-labeled slugs, plus a combined TOTAL row. */
export function scoreExtraction(goldenBySlug, actualBySlug) {
  const rows = CATEGORIES.map(({ key, keyFn }) => ({
    category: key,
    ...scoreCategory(goldenBySlug, actualBySlug, key, keyFn)
  }))
  const totals = rows.reduce(
    (acc, r) => ({ tp: acc.tp + r.tp, fp: acc.fp + r.fp, fn: acc.fn + r.fn }),
    { tp: 0, fp: 0, fn: 0 }
  )
  const total = {
    category: 'TOTAL',
    ...totals,
    precision: totals.tp + totals.fp === 0 ? 1 : totals.tp / (totals.tp + totals.fp),
    recall: totals.tp + totals.fn === 0 ? 1 : totals.tp / (totals.tp + totals.fn)
  }
  return [...rows, total]
}

/** Render the scored rows as a fixed-width table for terminal output. */
export function formatReport(rows) {
  const header = ['category', 'precision', 'recall', 'tp', 'fp', 'fn']
  const lines = [header.join('\t')]
  for (const r of rows) {
    lines.push([r.category, r.precision.toFixed(3), r.recall.toFixed(3), r.tp, r.fp, r.fn].join('\t'))
  }
  return lines.join('\n')
}

/**
 * Adapts a real MeetingExtraction object (singular nullable `account`/`deal`) into the golden
 * `expected.json`'s flat, plural comparison shape (Task MI-4). `confidence` is deliberately dropped —
 * every `keyFn` in CATEGORIES below already ignores it (numeric_facts scores on kind+value+unit alone),
 * so keeping the mapping minimal avoids a false sense of a richer comparison than actually happens.
 */
export function toScorable(extraction) {
  const x = extraction ?? {}
  return {
    people: (x.people ?? []).map((p) => ({ name: p.name, role: p.role ?? null, org: p.org ?? null })),
    accounts: x.account ? [{ name: x.account.name, sector: x.account.sector }] : [],
    deals: x.deal ? [{ name: x.deal.name, account: x.account?.name ?? '', stage: x.deal.stage }] : [],
    numeric_facts: (x.numeric_facts ?? []).map((f) => ({ kind: f.kind, value: f.value, unit: f.unit ?? null, quote: f.quote })),
    commitments: (x.commitments ?? []).map((c) => ({ text: c.text, by: c.by }))
  }
}

function loadGoldenBySlug(goldenDir) {
  const out = {}
  for (const f of readdirSync(goldenDir)) {
    if (!f.endsWith('.expected.json')) continue
    const slug = basename(f, '.expected.json')
    out[slug] = JSON.parse(readFileSync(join(goldenDir, f), 'utf8'))
  }
  return out
}

function loadActualBySlug(actualDir, slugs) {
  const out = {}
  for (const slug of slugs) {
    const file = join(actualDir, `${slug}.json`)
    out[slug] = existsSync(file) ? toScorable(JSON.parse(readFileSync(file, 'utf8'))) : {}
  }
  return out
}

export function runEval(actualDir, goldenDir) {
  const goldenBySlug = loadGoldenBySlug(resolve(goldenDir))
  const actualBySlug = loadActualBySlug(resolve(actualDir), Object.keys(goldenBySlug))
  return scoreExtraction(goldenBySlug, actualBySlug)
}

export function runEvalExtractionCli(args = process.argv.slice(2)) {
  const [actualDir, goldenDir] = args
  if (!actualDir || !goldenDir) {
    console.log('Usage: node scripts/eval-extraction.mjs <actual-dir> <golden-dir>')
    return
  }
  console.log(formatReport(runEval(actualDir, goldenDir)))
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runEvalExtractionCli()
  process.exitCode = 0 // reports only; never gates
}
