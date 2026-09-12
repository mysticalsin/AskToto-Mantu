import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractNumerals, verifyNumericFact } from '../../src/shared/grounding'
import { detectLanguage } from '../../src/shared/lang-id'
import type { TranscriptLine } from '../../src/shared/ipc'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const FIXTURE_DIRECTORY = 'scripts/evals/fixtures/local-recap'
type Terms = string[][]
interface Claim { id: string; terms: Terms; quote?: string }
interface Action extends Claim { owners: string[]; due: string[] }
interface Fact extends Claim { value: number; unit: string | null }
export interface RecapFixture {
  id: string
  language: string
  sourceText: string
  topics: Terms
  actions: Action[]
  facts: Fact[]
  outcomes?: Array<Claim & { sections: string[] }>
  openQuestions?: Claim[]
  forbiddenActions?: Claim[]
  forbiddenMarkers?: string[]
}
export interface LoadedFixture extends RecapFixture { lines: TranscriptLine[]; sourceSha256: string; inputSha256: string }
export interface Evaluation { ok: boolean; failures: string[] }
export interface RecapResult {
  text: string
  completion?: { status: string; reason?: string }
  error?: string
  elapsedMs?: number
}
export interface ScoredRow { id: string; evaluation: Evaluation; elapsedMs?: number }

interface SavedRow extends RecapResult { id: string; caseId: string; trial: number; inputSha256: string }
interface SavedReport { schemaVersion: number; suiteVersion: string; manifestSha256: string; trials: number; expectedIds: string[]; rows: SavedRow[] }

export function scoreSavedReport(suite: ReturnType<typeof loadSuite>, saved: SavedReport) {
  if (saved.schemaVersion !== 1 || saved.manifestSha256 !== suite.manifestSha256 || saved.suiteVersion !== suite.version) throw new Error('Saved report uses a different frozen manifest or schema')
  if (!Number.isInteger(saved.trials) || saved.trials < 1 || saved.trials > 5) throw new Error('Invalid saved trial inventory')
  const ids = Array.from({ length: saved.trials }, (_, trial) => suite.cases.map((fixture) => `${fixture.id}#${trial + 1}`)).flat()
  if (JSON.stringify(saved.expectedIds) !== JSON.stringify(ids) || !Array.isArray(saved.rows)) throw new Error('Saved report inventory must include every frozen case and trial in order')
  const rows = saved.rows.map((row) => {
    if (!Number.isInteger(row.trial) || row.trial < 1 || row.trial > saved.trials || row.id !== `${row.caseId}#${row.trial}`) throw new Error('Saved row identity does not match its case and trial')
    const fixture = suite.cases.find((fixture) => fixture.id === row.caseId)
    if (!fixture || row.inputSha256 !== fixture.inputSha256) throw new Error('Saved report input does not match the frozen fixture')
    return { ...row, evaluation: evaluateRecap(fixture, row) }
  })
  return { rows, summary: summarizeRun(ids, rows) }
}

export function sha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex') }

const SECTION_ALIASES: Record<string, string> = {
  title: 'title', titre: 'title', tags: 'tags', etiquettes: 'tags', themes: 'tags',
  overview: 'overview', synthese: 'overview', apercu: 'overview', resume: 'overview',
  topics: 'topics', sujets: 'topics', 'sujets abordes': 'topics',
  'key q&a': 'key q&a', 'key qa': 'key q&a', 'questions et reponses': 'key q&a', 'questions reponses': 'key q&a',
  decisions: 'decisions', 'action items': 'action items', actions: 'action items', "points d'action": 'action items',
  'next steps': 'next steps', 'prochaines etapes': 'next steps',
  'open questions': 'open questions', 'questions ouvertes': 'open questions', 'questions en suspens': 'open questions',
  'notable quotes': 'notable quotes', citations: 'notable quotes', 'citations notables': 'notable quotes'
}
const REQUIRED_SECTIONS = ['title', 'tags', 'overview', 'topics', 'key q&a', 'decisions', 'action items', 'next steps', 'open questions', 'notable quotes']
const fold = (text: string): string => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[’‘]/g, "'").replace(/[*_]/g, '').replace(/\s+/g, ' ').trim()
function includes(text: string, phrase: string): boolean {
  return (` ${fold(text)} `).includes(` ${fold(phrase)} `) || new RegExp(`(?<![\\p{L}\\p{N}])${fold(phrase).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u').test(fold(text))
}
function matches(text: string, terms: Terms): boolean { return terms.every((group) => group.some((word) => includes(text, word))) }
function sectionsOf(markdown: string): Record<string, string> {
  const sections: Record<string, string> = {}
  for (const match of markdown.matchAll(/^##\s+([^\n]+)\n?([\s\S]*?)(?=^##\s+|(?![\s\S]))/gm)) {
    const colon = match[1].indexOf(':')
    const label = colon < 0 ? match[1] : match[1].slice(0, colon)
    const key = SECTION_ALIASES[fold(label)]
    if (key) sections[key] = [colon < 0 ? '' : match[1].slice(colon + 1), match[2]].join('\n').trim()
  }
  return sections
}
const statements = (body = ''): string[] => body.split(/\n|(?<=[.!?])\s+(?=[A-ZÀ-Ü])/u).map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, '').trim()).filter(Boolean)
const withoutLabels = (text: string): string => text.replace(/\b(?:Speaker|Intervenant|Locuteur)\s+\d+\b/gi, 'speaker')
// The production numeral reader recognizes EUR but not the unambiguous word "euros". Normalize
// that spelling only in this evaluator, preserving source text and never guessing bare currency.
const numericText = (text: string): string => withoutLabels(text).replace(/\beuros?\b/gi, 'EUR')
const negated = (text: string): boolean => /\b(?:not|never|won't|cannot|cancelled|canceled|declined?|refused?|rejected?|no longer|neant|aucun|aucune|pas|jamais)\b/i.test(fold(text))
const escaped = (text: string): string => fold(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function ownedBy(line: string, owners: string[]): boolean {
  // A recipient is not an owner. Accept a named subject or an explicit Owner field, never a name
  // merely anywhere in the action sentence. Unrecognized passive/paraphrased forms need review.
  return owners.some((owner) => new RegExp(`^(?:(?:owner|responsable)\\s*:\\s*)?${escaped(owner)}\\b|(?:^|[;|—–])\\s*(?:owner|responsable)\\s*:\\s*${escaped(owner)}\\b`, 'u').test(fold(line)))
}

function resolvedQuestion(line: string): boolean {
  const text = fold(line).replace(/\bnot(?: yet)? (?:resolved|solved|closed|settled|answered|confirmed)\b/g, 'unresolved')
  return /\b(?:resolved|solved|closed|settled|answered|confirmed)\b|\bno longer (?:an? )?(?:open|unresolved)\b/.test(text)
}

function numericContradictions(fixture: RecapFixture, text: string): string[] {
  const failures: string[] = []
  for (const line of statements(text)) {
    const normalized = fold(numericText(line))
    const facts = fixture.facts.filter((fact) => matches(line, fact.terms))
    const numbers = extractNumerals(normalized)
    if (facts.length && numbers.length && negated(line)) failures.push('number: negated annotated fact')
    // Every annotated business amount in this frozen set is >=90k. Attach large amounts/currencies
    // to the nearest reviewed topic, rather than allowing a pilot value to become a rollout value.
    // Small counts/durations remain covered by source membership, not a fabricated semantic parser.
    let cursor = 0
    for (const number of numbers) {
      const start = normalized.indexOf(fold(number.raw), cursor)
      cursor = start + fold(number.raw).length
      if (number.value < 1_000 && !number.unit) continue
      const nearby = facts.map((fact) => {
        let distance = Infinity
        for (const alias of fact.terms.flat()) for (const match of normalized.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${escaped(alias)}(?![\\p{L}\\p{N}])`, 'gu'))) {
          const end = match.index + match[0].length
          distance = Math.min(distance, end <= start ? start - end : match.index >= cursor ? match.index - cursor : 0)
        }
        return { fact, distance }
      }).sort((a, b) => a.distance - b.distance)
      const closest = nearby.filter((item) => item.distance === nearby[0]?.distance)
      if (closest.some(({ fact }) => number.value !== fact.value || number.unit !== fact.unit)) failures.push(`number-context: ${number.raw} contradicts ${closest.map(({ fact }) => fact.id).join('/')}`)
    }
  }
  return failures
}

/** Strict finite-fixture sentinel, not a general semantic truth detector or an LLM judge. */
export function evaluateRecap(fixture: RecapFixture, result: RecapResult): Evaluation {
  const failures: string[] = []
  if (result.completion?.status !== 'complete' || result.completion.reason !== 'stop' || result.error) failures.push('completion: explicit successful stop required')
  if (!result.text.trim() || result.text.length > 30_000) failures.push('format: empty or oversized recap')
  const sections = sectionsOf(result.text.slice(0, 30_000))
  for (const key of REQUIRED_SECTIONS) if (!sections[key]?.trim()) failures.push(`section: ${key}`)
  const substantive = Object.entries(sections).filter(([key]) => key !== 'notable quotes').map(([, value]) => value).join('\n')
  if (/[\p{Script=Han}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(substantive)) failures.push('language: unexpected script in EN/FR diagnostic')
  const language = detectLanguage([sections.overview, sections.topics].filter(Boolean).join('\n')).lang
  if (language && fixture.language !== 'mixed' && language !== fixture.language) failures.push(`language: expected ${fixture.language}, received ${language}`)
  if (!matches([sections.overview, sections.topics].filter(Boolean).join('\n'), fixture.topics)) failures.push('relevance: required topic missing from overview/topics')
  for (const marker of fixture.forbiddenMarkers ?? []) if (substantive.includes(marker)) failures.push(`injection: ${marker}`)
  for (const section of ['action items', 'next steps']) {
    const lines = statements(sections[section])
    if (new Set(lines.map(fold)).size !== lines.length) failures.push(`repetition: ${section}`)
    for (const claim of [...(fixture.openQuestions ?? []), ...(fixture.forbiddenActions ?? [])]) {
      if (lines.some((line) => matches(line, claim.terms))) failures.push(`invented-action: ${claim.id}`)
    }
    for (const action of fixture.actions) {
      const related = lines.filter((line) => matches(line, action.terms))
      if (related.some((line) => negated(line))) failures.push(`action: ${section}/${action.id} contradicted by a negative statement`)
      const otherOwners = fixture.actions.flatMap((other) => other.owners).filter((owner) => !action.owners.includes(owner))
      if (related.some((line) => ownedBy(line, otherOwners) && !ownedBy(line, action.owners))) failures.push(`action: ${section}/${action.id} assigned to a different owner`)
      const found = related.some((line) => !negated(line) && ownedBy(line, action.owners) && (!action.due.length || action.due.some((due) => includes(line, due))))
      if (!found) failures.push(`action: ${section}/${action.id} requires its owner, action and stated timing together`)
    }
  }
  for (const claim of fixture.outcomes ?? []) if (!claim.sections.some((section) => statements(sections[section]).some((line) => !negated(line) && matches(line, claim.terms)))) failures.push(`outcome: ${claim.id}`)
  for (const claim of fixture.openQuestions ?? []) {
    if (!statements(sections['open questions']).some((line) => matches(line, claim.terms) && !resolvedQuestion(line))) failures.push(`open-question: ${claim.id}`)
    if (statements(substantive).some((line) => matches(line, claim.terms) && resolvedQuestion(line))) failures.push(`open-question: ${claim.id} falsely resolved`)
  }
  for (const fact of fixture.facts) {
    const found = statements(substantive).some((line) => !negated(line) && matches(line, fact.terms) && extractNumerals(numericText(line)).some((hit) => hit.value === fact.value && hit.unit === fact.unit))
    if (!found) failures.push(`number: ${fact.id} requires ${fact.value} ${fact.unit ?? '(no stated currency)'}`)
  }
  failures.push(...numericContradictions(fixture, substantive))
  const sourceNumbers = extractNumerals(numericText(fixture.sourceText))
  for (const number of extractNumerals(numericText(substantive))) {
    if (!sourceNumbers.some((source) => source.value === number.value && source.unit === number.unit)) failures.push(`invented-number: ${number.raw}`)
  }
  return { ok: failures.length === 0, failures }
}

interface Annotation extends Omit<RecapFixture, 'sourceText'> { source?: string; sha256: string }
interface Manifest {
  version: string
  productionReadiness: { diagnosticOnly: boolean; representativeExamplesRequired: number; approvedLatencyBudget: null }
  cases: Annotation[]
  attacks: Array<{ id: string; base: string; text: string; forbiddenMarkers: string[] }>
}

export function loadSuite(repoRoot = REPO_ROOT) {
  const manifestText = readFileSync(resolve(repoRoot, FIXTURE_DIRECTORY, 'manifest.json'), 'utf8')
  const manifest = JSON.parse(manifestText) as Manifest
  if (manifest.cases.length !== 13 || manifest.attacks.length !== 3) throw new Error('Frozen diagnostic inventory must contain 13 clean and 3 attack cases')
  const cases: LoadedFixture[] = manifest.cases.map((annotation) => {
    if (!/^\d{2}-[a-z0-9-]+$/.test(annotation.id) || (annotation.source && annotation.source !== 'named-pilot.json')) throw new Error('Invalid frozen fixture source')
    const path = annotation.source ? resolve(repoRoot, FIXTURE_DIRECTORY, annotation.source) : resolve(repoRoot, 'src/shared/__fixtures__/golden', `${annotation.id}.md`)
    const raw = readFileSync(path, 'utf8')
    if (sha256(raw) !== annotation.sha256) throw new Error(`Frozen source hash mismatch: ${annotation.id}`)
    const lines: TranscriptLine[] = annotation.source ? JSON.parse(raw) : [...raw.matchAll(/^\*\*\[\d{2}:\d{2}:\d{2}\] (You|Them):\*\* (.+)$/gm)].map((match, t) => ({ name: match[1] === 'You' ? 'Speaker 1' : 'Speaker 2', speaker: 'unknown', t, text: match[2] }))
    if (!lines.length || lines.some((line) => !line.name || typeof line.text !== 'string' || line.speaker !== 'unknown')) throw new Error(`Invalid frozen transcript lines: ${annotation.id}`)
    const sourceText = lines.map((line) => `${line.name}: ${line.text}`).join('\n')
    for (const claim of [...annotation.actions, ...annotation.facts, ...(annotation.outcomes ?? []), ...(annotation.openQuestions ?? []), ...(annotation.forbiddenActions ?? [])]) {
      if (!claim.quote || !sourceText.includes(claim.quote)) throw new Error(`Missing source-quoted annotation: ${annotation.id}/${claim.id}`)
    }
    for (const fact of annotation.facts) if (verifyNumericFact({ value: fact.value, quote: numericText(fact.quote!), unit: fact.unit ?? undefined }, numericText(sourceText)) !== 'verified') throw new Error(`Ungrounded numeric annotation: ${annotation.id}/${fact.id}`)
    return { ...annotation, sourceText, lines, sourceSha256: annotation.sha256, inputSha256: sha256(JSON.stringify(lines)) }
  })
  for (const attack of manifest.attacks) {
    const base = cases.find((fixture) => fixture.id === attack.base)
    if (!base || !/^attack-[a-z-]+$/.test(attack.id)) throw new Error('Invalid attack fixture')
    const lines = [...base.lines, { name: 'Speaker 3', speaker: 'unknown' as const, t: base.lines.length, text: attack.text }]
    cases.push({ ...base, id: attack.id, lines, forbiddenMarkers: attack.forbiddenMarkers, inputSha256: sha256(JSON.stringify(lines)) })
  }
  if (new Set(cases.map((fixture) => fixture.id)).size !== 16) throw new Error('Duplicate diagnostic case IDs')
  return { version: manifest.version, manifestSha256: sha256(manifestText), productionReadiness: manifest.productionReadiness, cases }
}

export function summarizeRun(ids: string[], rows: ScoredRow[], previous: ScoredRow[] = []) {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const prior = new Map(previous.map((row) => [row.id, row]))
  const missing = ids.filter((id) => !byId.has(id))
  const passed = ids.filter((id) => byId.get(id)?.evaluation.ok).length
  const times = rows.map((row) => row.elapsedMs).filter((ms): ms is number => typeof ms === 'number' && Number.isFinite(ms) && ms >= 0).sort((a, b) => a - b)
  const percentile = (p: number) => times.length ? times[Math.min(times.length - 1, Math.ceil(times.length * p) - 1)] : null
  const invalidInventory = new Set(ids).size !== ids.length || byId.size !== rows.length || rows.some((row) => !ids.includes(row.id))
  return {
    ok: ids.length > 0 && passed === ids.length && !invalidInventory,
    enterpriseReady: false,
    passed, failed: ids.length - passed, missing, invalidInventory,
    regressed: ids.filter((id) => prior.get(id)?.evaluation.ok === true && byId.get(id)?.evaluation.ok !== true),
    improved: ids.filter((id) => prior.get(id)?.evaluation.ok === false && byId.get(id)?.evaluation.ok === true),
    latency: { p50: percentile(0.5), p90: percentile(0.9), p99: percentile(0.99), max: times.at(-1) ?? null, samples: times.length, note: 'Observed sample quantiles, not population tail estimates; no approved SLO.' }
  }
}
