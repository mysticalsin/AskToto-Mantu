// Use-case acceptance registry gate (M2-0441).
//
// scripts/qa/uc-registry.json holds ONE row per use case, UC-001..UC-112, each naming its owning ticket(s),
// the test id(s) that prove it and the evidence level reached. A range is never a row and one representative
// never passes a range: a row passes only on a result recorded against ITS OWN id. The catalogue regression
// (M2-0173) reads this registry through `regressionReport` and reports every row; there is no subset mode,
// so an unknown flag is refused rather than ignored.
//
// Row fields: id, tickets (M2-#### ids), tests ([{ id, file }]), evidence (an EVIDENCE_LEVELS value, or null
// while unmapped), externalBlocker (null, or the exact outside step when the row needs an outside account, a
// real cloud-file provider or a physical QA machine; such a row reports BLOCKED_EXTERNAL and is not faked).
// A row that is still unmapped (no test, ticket or evidence level) must say why in `note`, as
// `LEAD_ACTION: <exact step>`, so an empty row is never unexplained; it still fails the gate.
// Results file: JSON array of { uc, testId, status: 'pass' | 'fail' }. `--vitest <report.json>` derives it from a
// vitest JSON report: a test id is the test's full name and `file` is its repo-relative path, so each row is
// judged only by its own tests. A named --results/--vitest file that is missing is an error, not an empty run.
//
// Under D-28 this runs only in GitHub Actions (.github/workflows/uc-regression.yml).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { EVIDENCE_LEVELS } from '../evidence/record.mjs'

export const UC_COUNT = 112
export const EXPECTED_IDS = Object.freeze(Array.from({ length: UC_COUNT }, (_, i) => `UC-${String(i + 1).padStart(3, '0')}`))
const UC_ID_RE = /^UC-\d{3}$/
const TICKET_RE = /^M2-\d{4}$/
const LEAD_ACTION_RE = /^LEAD_ACTION: \S/

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Structural problems: the row set is exactly UC-001..UC-112, once each, and every field is well formed. */
export function registryShapeProblems(registry) {
  const problems = []
  const rows = Array.isArray(registry?.rows) ? registry.rows : null
  if (!rows) return ['registry: rows must be an array']
  const seen = new Set()
  for (const row of rows) {
    const id = isPlainObject(row) ? row.id : undefined
    if (typeof id !== 'string' || !UC_ID_RE.test(id)) {
      problems.push(`registry: row id ${JSON.stringify(id)} is not a single UC-### id (ranges are not rows)`)
      continue
    }
    if (seen.has(id)) problems.push(`${id}: duplicate row`)
    seen.add(id)
    if (!Array.isArray(row.tickets) || row.tickets.some((t) => typeof t !== 'string' || !TICKET_RE.test(t))) {
      problems.push(`${id}: tickets must be an array of M2-#### ids`)
    }
    if (!Array.isArray(row.tests) || row.tests.some((t) => !isPlainObject(t) || typeof t.id !== 'string' || t.id === '' || typeof t.file !== 'string' || t.file === '')) {
      problems.push(`${id}: tests must be an array of { id, file }`)
    }
    if (row.evidence !== null && !EVIDENCE_LEVELS.includes(row.evidence)) {
      problems.push(`${id}: evidence must be null or one of ${EVIDENCE_LEVELS.join(', ')}`)
    }
    if (row.externalBlocker !== null && (typeof row.externalBlocker !== 'string' || row.externalBlocker === '')) {
      problems.push(`${id}: externalBlocker must be null or the exact unblock step`)
    }
    if (row.note !== undefined && row.note !== null && (typeof row.note !== 'string' || row.note === '')) {
      problems.push(`${id}: note must be a non-empty string when present`)
    }
    const unmapped = !Array.isArray(row.tests) || row.tests.length === 0 || !Array.isArray(row.tickets) || row.tickets.length === 0 || row.evidence === null
    if (unmapped && row.externalBlocker === null && !(typeof row.note === 'string' && LEAD_ACTION_RE.test(row.note))) {
      problems.push(`${id}: an unmapped row needs a "LEAD_ACTION: <exact step>" note`)
    }
  }
  for (const id of EXPECTED_IDS) if (!seen.has(id)) problems.push(`${id}: missing row`)
  return problems
}

/** Mapping problems: a row that is not BLOCKED_EXTERNAL needs a test, an owning ticket and an evidence level. */
export function registryMappingProblems(registry) {
  const problems = []
  for (const row of registry.rows) {
    if (row.externalBlocker !== null) continue
    if (row.tests.length === 0) problems.push(`${row.id}: no test`)
    if (row.tickets.length === 0) problems.push(`${row.id}: no owning ticket`)
    if (row.evidence === null) problems.push(`${row.id}: no evidence level`)
  }
  return problems
}

/** Result problems: a result must name one UC row and one of its own tests; ranges and strangers are refused. */
export function resultProblems(registry, results) {
  if (!Array.isArray(results)) return ['results: must be an array']
  const byId = new Map(registry.rows.map((row) => [row.id, row]))
  const problems = []
  for (const result of results) {
    const uc = isPlainObject(result) ? result.uc : undefined
    if (typeof uc !== 'string' || !UC_ID_RE.test(uc)) {
      problems.push(`results: ${JSON.stringify(uc)} is not a single UC-### id; a range cannot be marked passed on a representative`)
    } else if (!byId.get(uc)?.tests.some((t) => t.id === result.testId)) {
      problems.push(`${uc}: result names test ${JSON.stringify(result.testId)} which is not one of the row's tests`)
    } else if (result.status !== 'pass' && result.status !== 'fail') {
      problems.push(`${uc}: result status must be 'pass' or 'fail'`)
    }
  }
  return problems
}

/**
 * Per-row verdicts, one for every registry row. A row is PASS only when every one of its tests has a passing
 * result recorded against that row; UNMAPPED, NOT_RUN and FAIL all fail the gate, BLOCKED_EXTERNAL does not.
 * @returns {{ rows: { id: string, status: string, tickets: string[], tests: string[], evidence: string, externalBlocker: string | null }[], problems: string[], ok: boolean }}
 */
export function regressionReport(registry, results) {
  const shape = registryShapeProblems(registry)
  if (shape.length > 0) return { rows: [], problems: shape, ok: false }
  const problems = resultProblems(registry, results)
  const valid = Array.isArray(results) ? results.filter((r) => isPlainObject(r)) : []
  const rows = registry.rows.map((row) => {
    const own = valid.filter((r) => r.uc === row.id && row.tests.some((t) => t.id === r.testId))
    let status
    if (row.externalBlocker !== null) status = 'BLOCKED_EXTERNAL'
    else if (registryMappingProblems({ rows: [row] }).length > 0) status = 'UNMAPPED'
    else if (own.some((r) => r.status === 'fail')) status = 'FAIL'
    else if (row.tests.every((t) => own.some((r) => r.testId === t.id && r.status === 'pass'))) status = 'PASS'
    else status = 'NOT_RUN'
    return { id: row.id, status, tickets: row.tickets, tests: row.tests.map((t) => t.id), evidence: row.evidence, externalBlocker: row.externalBlocker }
  })
  const ok = problems.length === 0 && rows.every((r) => r.status === 'PASS' || r.status === 'BLOCKED_EXTERNAL')
  return { rows, problems, ok }
}

/** The distinct test files the registry names, so a CI lane runs exactly the tests the rows depend on. */
export function registryTestFiles(registry) {
  return [...new Set(registry.rows.flatMap((row) => row.tests.map((t) => t.file)))].sort()
}

/**
 * Per-row results from a vitest JSON report. A registry test matches the assertion whose full name equals its id
 * in the report file ending with its `file`; a test the report does not contain yields no result (NOT_RUN).
 * A skipped or todo test is not a pass.
 */
export function resultsFromVitest(registry, report) {
  const files = Array.isArray(report?.testResults) ? report.testResults : []
  const results = []
  for (const row of registry.rows) {
    for (const test of row.tests) {
      const file = files.find((f) => typeof f?.name === 'string' && f.name.replaceAll('\\', '/').endsWith(`/${test.file}`))
      const found = file?.assertionResults?.find((a) => a.fullName === test.id)
      if (!found) continue
      results.push({ uc: row.id, testId: test.id, status: found.status === 'passed' ? 'pass' : 'fail' })
    }
  }
  return results
}

export function reportMarkdown(report) {
  const counts = {}
  for (const row of report.rows) counts[row.status] = (counts[row.status] ?? 0) + 1
  return [
    '# UC-001..UC-112 catalogue regression',
    '',
    `Rows: ${report.rows.length}. ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}. Gate: ${report.ok ? 'PASS' : 'FAIL'}.`,
    ...report.problems.map((p) => `- problem: ${p}`),
    '',
    '| Row | Status | Tickets | Tests | Evidence |',
    '|---|---|---|---|---|',
    ...report.rows.map((r) => `| ${r.id} | ${r.status} | ${r.tickets.join(', ')} | ${r.tests.join(', ')} | ${r.externalBlocker ?? r.evidence ?? ''} |`)
  ].join('\n')
}

function main() {
  const { values } = parseArgs({
    options: {
      registry: { type: 'string' },
      results: { type: 'string' },
      vitest: { type: 'string' },
      'list-files': { type: 'boolean' },
      out: { type: 'string' }
    }
  })
  const here = dirname(fileURLToPath(import.meta.url))
  const registry = JSON.parse(readFileSync(resolve(values.registry ?? join(here, 'uc-registry.json')), 'utf8'))
  if (values['list-files']) {
    console.log(registryTestFiles(registry).join('\n'))
    return
  }
  for (const named of [values.results, values.vitest]) {
    if (named !== undefined && !existsSync(named)) {
      console.error(`uc-registry: results file not found: ${named}`)
      process.exit(2)
    }
  }
  let results = []
  if (values.results) results = JSON.parse(readFileSync(values.results, 'utf8'))
  else if (values.vitest) results = resultsFromVitest(registry, JSON.parse(readFileSync(values.vitest, 'utf8')))
  const report = regressionReport(registry, results)
  const outDir = resolve(values.out ?? 'out/uc-regression')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(join(outDir, 'report.md'), `${reportMarkdown(report)}\n`)
  console.log(reportMarkdown(report))
  process.exit(report.ok ? 0 : 1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
