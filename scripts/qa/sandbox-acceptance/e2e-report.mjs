#!/usr/bin/env node
// G88 (CAP-40): join capability-map.json with a set of acceptance reports into one per-CAP and per-E2E-case table.
//
//   node scripts/qa/sandbox-acceptance/e2e-report.mjs <acceptance-*.json>... [--map <capability-map.json>] [--json]
//
// Reads files only; it launches nothing. Exit 0: table printed, no FAIL. Exit 1: a row FAILED. Exit 2: a report is unreadable, has
// no valid binding, or the reports disagree on commit, installer sha256 or app hash (one table never mixes artifacts).
// A step that was NOT_SUPPORTED stays NOT_SUPPORTED; owner, hardware and external rows are listed, never turned into a PASS.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bindingProblems, bindingsAgree } from './binding.mjs'
import { MAP_SCENARIO_STEPS } from './scenario-registry.mjs'
import { mapProblems } from './capability-map.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_MAP_PATH = join(HERE, 'capability-map.json')

/** Worst first: a FAIL outranks a gap, a gap outranks a pass. */
const SANDBOX_ORDER = ['FAIL', 'NOT_RUN', 'NOT_SUPPORTED', 'PASS']

/** The latest report of each scenario, by start time. */
function latestByScenario(reports) {
  const latest = new Map()
  for (const report of reports) {
    const scenario = report?.config?.scenario
    if (!scenario) continue
    const current = latest.get(scenario)
    if (!current || String(report.startedAt) > String(current.startedAt)) latest.set(scenario, report)
  }
  return latest
}

/** Status of one sandbox row: every named step must be recorded by the scenario's report. */
function sandboxStatus(row, latest) {
  const report = latest.get(row.scenario)
  if (!report) return 'NOT_RUN'
  const statuses = row.steps.map((id) => report.steps?.find((step) => step.id === id)?.status ?? 'NOT_RUN')
  for (const status of SANDBOX_ORDER) {
    if (status === 'NOT_RUN' && statuses.some((s) => s === 'NOT_RUN' || s === 'SKIPPED')) return 'NOT_RUN'
    if (statuses.includes(status)) return status
  }
  return 'NOT_RUN'
}

const STATIC_STATUS = Object.freeze({
  'ci-only': 'CI_ONLY',
  'owner-checklist': 'OWNER',
  'blocked-external': 'BLOCKED_EXTERNAL',
  'pending-disposition': 'PENDING',
  'not-in-2.12': 'NOT_IN_2.12'
})

function rowStatus(row, latest) {
  return row.kind === 'sandbox' ? sandboxStatus(row, latest) : STATIC_STATUS[row.kind]
}

const rollup = (rows) => rows.map((row) => row.status)

/**
 * Pure join. `reports` are parsed acceptance reports (already checked for bindings by `bindReports`).
 * @returns {{ capabilities: { id: string, title: string, rows: { kind: string, status: string, target: string | null }[] }[], e2e: { id: string, case: string, caps: string[], rows: { kind: string, status: string, target: string | null }[] }[], counts: Record<string, number> }}
 */
export function joinReports(map, reports) {
  const latest = latestByScenario(reports)
  const project = (row) => ({
    kind: row.kind,
    status: rowStatus(row, latest),
    target: row.target ?? null,
    ...(row.kind === 'sandbox' ? { scenario: row.scenario, steps: row.steps } : {})
  })
  const capabilities = map.capabilities.map((cap) => ({ id: cap.id, title: cap.title, rows: cap.rows.map(project) }))
  const e2e = map.e2e.map((entry) => ({
    id: entry.id,
    case: entry.case,
    caps: entry.caps,
    rows: entry.rows.map(project)
  }))
  const counts = {}
  for (const item of [...capabilities, ...e2e])
    for (const status of rollup(item.rows)) counts[status] = (counts[status] ?? 0) + 1
  return { capabilities, e2e, counts }
}

/**
 * The bindings of a set of reports, or the reason they cannot share one table.
 * @returns {{ ok: true, binding: Record<string, unknown> | null } | { ok: false, problem: string }}
 */
export function bindReports(reports) {
  const bindings = []
  for (const [index, report] of reports.entries()) {
    const binding = report?.meta?.binding
    const problems = bindingProblems(binding)
    if (problems.length) return { ok: false, problem: `report ${index + 1}: ${problems[0]}` }
    bindings.push(binding)
  }
  const verdict = bindingsAgree(bindings)
  if (!verdict.agree) return { ok: false, problem: verdict.disagreement }
  return { ok: true, binding: bindings[0] ?? null }
}

export function formatTable(joined) {
  const line = (label, rows) => `${label.padEnd(14)} ${[...new Set(rollup(rows))].join(', ')}`
  return [
    'CAPABILITIES',
    ...joined.capabilities.map((cap) => line(cap.id, cap.rows)),
    '',
    'E2E CASES',
    ...joined.e2e.map((entry) => line(`${entry.id} ${entry.case}`, entry.rows)),
    '',
    `counts ${JSON.stringify(joined.counts)}`
  ].join('\n')
}

function parseArgs(argv) {
  const files = []
  let mapPath = DEFAULT_MAP_PATH
  let json = false
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--map') mapPath = argv[(index += 1)]
    else if (argv[index] === '--json') json = true
    else files.push(argv[index])
  }
  return { files, mapPath, json }
}

export function main(
  argv,
  { read = (path) => readFileSync(path, 'utf8'), out = console.log, err = console.error } = {}
) {
  const { files, mapPath, json } = parseArgs(argv)
  let map
  try {
    map = JSON.parse(read(mapPath))
  } catch (error) {
    err(`[e2e-report] cannot read the map: ${error.message}`)
    return 2
  }
  const mapIssues = mapProblems(map, MAP_SCENARIO_STEPS)
  if (mapIssues.length) {
    err(`[e2e-report] the capability map is invalid (${mapIssues.length}): ${mapIssues[0]}`)
    return 2
  }
  const reports = []
  for (const file of files) {
    try {
      reports.push(JSON.parse(read(file)))
    } catch (error) {
      err(`[e2e-report] cannot read ${file}: ${error.message}`)
      return 2
    }
  }
  const bound = bindReports(reports)
  if (!bound.ok) {
    err(`[e2e-report] refusing to join these reports: ${bound.problem}`)
    return 2
  }
  const joined = joinReports(map, reports)
  out(json ? JSON.stringify({ binding: bound.binding, ...joined }, null, 2) : formatTable(joined))
  return joined.counts.FAIL ? 1 : 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2))
}
