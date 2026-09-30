#!/usr/bin/env node
/**
 * Packaged-smoke baseline comparator (M2-0461).
 *
 * BLOCKED_EXTERNAL rows never fail their own gate step (M2-0233), so a row the hosted runner used to drive
 * and no longer can would leave the smoke green. This compares the content-free row reports in a job's
 * smoke-report/ directory with scripts/qa/smoke-baseline.json, the status each row reaches on the hosted
 * m2/integration baseline. Invariant: a baseline-PASS row that is BLOCKED_EXTERNAL, NOT_RUN or missing now is
 * a regression (exit 1); a row that was never drivable stays a warning. FAIL rows are left to the existing
 * gate steps. Only the named report files are read; every other file in the directory is ignored.
 *
 *   node scripts/qa/smoke-baseline.mjs <smoke-report dir> [darwin|win32] [baseline.json]
 *
 * Exit 0 no regression · 1 regression · 2 usage, malformed baseline or malformed named report.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_BASELINE = join(dirname(fileURLToPath(import.meta.url)), 'smoke-baseline.json')
// The reports each platform's packaged-smoke job produces; nothing else in the directory is read.
const REPORTS = Object.freeze({
  darwin: ['hk-m', 'sidecar-boot-reaper', 'mac-helper-supervise', 'packaged-smoke'],
  win32: ['sidecar-boot-reaper', 'packaged-smoke']
})
const BASELINE_STATUSES = Object.freeze(['PASS', 'BLOCKED_EXTERNAL'])
const SEVERITY = Object.freeze({ PASS: 0, BLOCKED_EXTERNAL: 1, NOT_RUN: 2, FAIL: 3 })

export class MalformedInput extends Error {}

export function loadBaseline(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new MalformedInput('smoke baseline is not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.platforms || typeof parsed.platforms !== 'object') {
    throw new MalformedInput('smoke baseline has no platforms object')
  }
  for (const [platform, entry] of Object.entries(parsed.platforms)) {
    if (!REPORTS[platform]) throw new MalformedInput(`smoke baseline names unknown platform ${platform}`)
    if (!entry || typeof entry.rows !== 'object' || entry.rows === null) {
      throw new MalformedInput(`smoke baseline platform ${platform} has no rows`)
    }
    for (const [id, row] of Object.entries(entry.rows)) {
      if (!row || !BASELINE_STATUSES.includes(row.status)) {
        throw new MalformedInput(`smoke baseline row ${platform}/${id} needs status PASS or BLOCKED_EXTERNAL`)
      }
      if (row.status === 'BLOCKED_EXTERNAL') {
        const hasReason = typeof row.reason === 'string' && row.reason.trim() !== ''
        const hasTicket = typeof row.ticket === 'string' && /^M2-\d{4}$/.test(row.ticket)
        if (!hasReason || !hasTicket) {
          throw new MalformedInput(`smoke baseline BLOCKED_EXTERNAL row ${platform}/${id} needs a reason and a ticket id`)
        }
      }
    }
  }
  return parsed
}

function readReport(dir, name) {
  const path = join(dir, `${name}.json`)
  if (!existsSync(path)) return null
  try {
    const report = JSON.parse(readFileSync(path, 'utf8'))
    if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('not an object')
    return report
  } catch {
    throw new MalformedInput(`${name}.json is not a valid report`)
  }
}

function requireArray(value, name, field) {
  if (!Array.isArray(value)) throw new MalformedInput(`${name}.json has no ${field} array`)
  return value
}

function proofRow(proof, name, field) {
  if (!proof || typeof proof !== 'object') throw new MalformedInput(`${name}.json has no proofs.${field}`)
  const status = proof.result === 'pass' ? 'PASS' : proof.result === 'BLOCKED_EXTERNAL' ? 'BLOCKED_EXTERNAL' : 'FAIL'
  return { status, unblock: proof.unblock ?? null }
}

function put(rows, id, row) {
  const status = row.status in SEVERITY ? row.status : 'NOT_RUN'
  const unblock = row.unblock ?? row.failure ?? null
  const previous = rows.get(id)
  // Several HK-M cycles share one row id; the worst status decides it.
  if (!previous || SEVERITY[status] > SEVERITY[previous.status]) rows.set(id, { status, unblock })
}

/** Row id -> { status, unblock } from the named reports present in `dir`. */
export function collectRows(dir, platform) {
  const rows = new Map()
  for (const name of REPORTS[platform]) {
    const report = readReport(dir, name)
    if (!report) continue
    if (name === 'hk-m') {
      for (const row of requireArray(report.rows, name, 'rows')) put(rows, `hk-m/${row.scenario}`, row)
    } else if (name === 'sidecar-boot-reaper') {
      if (!report.proofs || typeof report.proofs !== 'object') throw new MalformedInput(`${name}.json has no proofs`)
      for (const field of ['standIn', 'realLlama']) put(rows, `${name}/${field}`, proofRow(report.proofs[field], name, field))
    } else if (name === 'mac-helper-supervise') {
      put(rows, name, { status: report.result === 'pass' ? 'PASS' : 'FAIL' })
    } else {
      for (const field of ['rv', 'navigationGuard']) {
        for (const row of requireArray(report[field], name, field)) put(rows, `${name}/${row.id}`, row)
      }
    }
  }
  return rows
}

function annotation(level, title, message) {
  const data = message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
  return `::${level} title=${title}::${data}`
}

/** Compares current rows with the platform's baseline rows; pure. */
export function compareRows(baselineRows, currentRows) {
  const annotations = []
  const table = []
  let regressions = 0
  for (const [id, base] of Object.entries(baselineRows)) {
    const current = currentRows.get(id)
    const status = current ? current.status : 'MISSING'
    const unblock = current?.unblock ?? 'none recorded'
    table.push({ id, baseline: base.status, current: status })
    if (base.status === 'PASS' && (status === 'BLOCKED_EXTERNAL' || status === 'NOT_RUN' || status === 'MISSING')) {
      regressions += 1
      annotations.push(
        annotation('error', 'Smoke row regressed', `${id}: baseline ${base.status}, current ${status}. Unblock: ${unblock}`)
      )
    } else if (base.status === 'BLOCKED_EXTERNAL' && status === 'PASS') {
      annotations.push(annotation('notice', 'Promote smoke row', `${id} now passes; promote it to PASS in scripts/qa/smoke-baseline.json.`))
    } else if (base.status === 'BLOCKED_EXTERNAL' && status !== 'FAIL') {
      annotations.push(annotation('warning', 'Smoke row blocked', `${id} stays BLOCKED_EXTERNAL (${base.ticket}): ${base.reason}`))
    }
  }
  for (const [id, current] of currentRows) {
    if (id in baselineRows) continue
    table.push({ id, baseline: 'absent', current: current.status })
    annotations.push(annotation('warning', 'Smoke row not in baseline', `${id} is ${current.status} but has no entry in scripts/qa/smoke-baseline.json.`))
  }
  return { annotations, table, regressions }
}

function summaryMarkdown(platform, seededFromRun, table) {
  return [
    `### Smoke baseline vs current (${platform}, baseline from run ${seededFromRun})`,
    '',
    '| Row | Baseline | Current |',
    '| --- | --- | --- |',
    ...table.map((row) => `| ${row.id} | ${row.baseline} | ${row.current} |`),
    ''
  ].join('\n')
}

/** Runs the comparison; returns the exit code, the annotation lines and the job-summary markdown. */
export function runComparator({ dir, platform, baselineText }) {
  if (!REPORTS[platform]) throw new MalformedInput(`unsupported platform ${platform}`)
  const baseline = loadBaseline(baselineText)
  const baselineRows = baseline.platforms[platform]?.rows
  if (!baselineRows) throw new MalformedInput(`smoke baseline has no rows for ${platform}`)
  const { annotations, table, regressions } = compareRows(baselineRows, collectRows(dir, platform))
  return {
    exitCode: regressions > 0 ? 1 : 0,
    annotations,
    summary: summaryMarkdown(platform, baseline.seededFromRun, table)
  }
}

function main(argv) {
  const [dir, platform = process.platform, baselinePath = DEFAULT_BASELINE] = argv
  if (!dir) throw new MalformedInput('usage: node scripts/qa/smoke-baseline.mjs <smoke-report dir> [darwin|win32] [baseline.json]')
  const result = runComparator({ dir, platform, baselineText: readFileSync(baselinePath, 'utf8') })
  for (const line of result.annotations) console.log(line)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${result.summary}\n`)
  else console.log(result.summary)
  process.exit(result.exitCode)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  }
}
