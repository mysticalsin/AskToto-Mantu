#!/usr/bin/env node
// Release decision (M2-0171): PASS/FAIL computed on one commit from the evidence registry and the
// traceability matrix, never asserted. PASS means engineering-complete; the real-environment column
// (rows waiting on an outside account, provider or QA machine) is reported beside it, not folded in.
//
//   node scripts/release/decide.mjs --commit HEAD [--ledger <tickets.json>] [--matrix <matrix.json>] [--out <dir>] [--detail-out <dir>]
//
// The ledger, its evidence/records store and the matrix live in the private program checkout, so their
// paths are arguments. --out gets the public-safe report (ids, statuses, counts); --detail-out gets the
// full report and is for private program CI only. Missing or unreadable inputs are a FAIL, not a skip. Exit 0 = PASS, 1 = FAIL.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { readRecordStore } from '../evidence/record.mjs'
import { lintContract } from './contract-lint.mjs'

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
export const DEFAULT_OUT = 'out/release-decision'

function readJson(path, label, problems) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    problems.push(`${label} ${path}: ${error.code === 'ENOENT' ? 'not found' : error.message}`)
    return null
  }
}

/**
 * Commits that touched `paths` after `since` on the way to `commit`'s history, minus those naming the
 * ticket in their subject. Read-only git; a shallow clone that cannot answer throws rather than
 * reporting "nothing changed".
 */
export function gitForeignChanges({ cwd, releaseCommit }) {
  return ({ paths, since, ticket }) => {
    const out = execFileSync('git', ['log', `--since=${since}`, '--format=%h%x09%s', releaseCommit, '--', ...paths], { cwd, encoding: 'utf8' })
    return out
      .split('\n')
      .filter(Boolean)
      .filter((line) => !line.split('\t')[1]?.includes(ticket))
      .map((line) => line.split('\t')[0])
  }
}

/**
 * @param {{ledgerPath: string, matrixPath: string, releaseCommit: string, foreignChanges: Function}} input
 * @returns {object} the decision document
 */
export function decide({ ledgerPath, matrixPath, releaseCommit, foreignChanges }) {
  const inputProblems = []
  const ledger = readJson(ledgerPath, 'ledger', inputProblems)
  const matrix = readJson(matrixPath, 'traceability matrix', inputProblems)
  if (!ledger || !matrix) {
    return { commit: releaseCommit, decision: 'FAIL', input_problems: inputProblems, checks: [], missing: [], stale: [], blocked: [], engineering: 'INCOMPLETE', real_environment: 'UNKNOWN' }
  }
  const recordsDir = join(resolve(dirname(ledgerPath), '..'), 'evidence', 'records')
  const { recordsByTicket, problems: storeProblems } = readRecordStore(recordsDir)
  const report = lintContract({ ledger, recordsByTicket, storeProblems, matrix, foreignChanges })
  return { commit: releaseCommit, decision: report.engineering === 'COMPLETE' ? 'PASS' : 'FAIL', input_problems: [], ...report }
}

export function renderMarkdown(decision) {
  const lines = [
    `# Release decision: ${decision.decision}`,
    '',
    `Commit: \`${decision.commit}\``,
    `Engineering: ${decision.engineering}. Real environment: ${decision.real_environment}.`,
    ''
  ]
  for (const problem of decision.input_problems) lines.push(`- INPUT: ${problem}`)
  for (const check of decision.checks) {
    lines.push(`## ${check.id} ${check.status} - ${check.title}`)
    for (const problem of check.problems) lines.push(`- ${problem}`)
  }
  lines.push('', '## Missing receipts')
  for (const m of decision.missing) lines.push(`- ${m.ticket} ${m.level}: ${m.reason}`)
  lines.push('', '## Stale receipts')
  for (const s of decision.stale) lines.push(`- ${s.ticket} ${s.level}: recorded ${s.recorded_at}, scope changed by ${s.changed_by.join(', ')}`)
  lines.push('', '## BLOCKED_EXTERNAL rows')
  for (const b of decision.blocked) {
    const detail = b.unblock_step ? `owner ${b.owner}; unblock: ${b.unblock_step}; needed by ${b.needed_by}` : 'no external blocker recorded; waiting on a lead action'
    lines.push(`- ${b.ticket} (${b.status}${b.via ? `, via ${b.via}` : ''}): ${detail}`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * The document for the public artifact: check ids, statuses, counts and ticket ids only. Ledger text
 * (problem strings, finding refs, owners, unblock steps) stays out because this repository is public;
 * the full report goes to --detail-out, which the private program repository's CI supplies.
 */
export function publicReport(decision) {
  return {
    commit: decision.commit,
    decision: decision.decision,
    engineering: decision.engineering,
    real_environment: decision.real_environment,
    input_problem_count: decision.input_problems.length,
    checks: decision.checks.map((check) => ({ id: check.id, status: check.status, problem_count: check.problems.length })),
    missing: { count: decision.missing.length, tickets: [...new Set(decision.missing.map((m) => m.ticket))] },
    stale: { count: decision.stale.length, tickets: [...new Set(decision.stale.map((s) => s.ticket))] },
    blocked: { count: decision.blocked.length, tickets: decision.blocked.map((b) => b.ticket) }
  }
}

export function renderPublicMarkdown(report) {
  const ids = (group) => (group.tickets.length ? group.tickets.join(', ') : 'none')
  return `${[
    `# Release decision: ${report.decision}`,
    '',
    `Commit: \`${report.commit}\``,
    `Engineering: ${report.engineering}. Real environment: ${report.real_environment}.`,
    `Input problems: ${report.input_problem_count}`,
    '',
    ...report.checks.map((check) => `- ${check.id} ${check.status} (${check.problem_count})`),
    '',
    `Missing receipts (${report.missing.count}): ${ids(report.missing)}`,
    `Stale receipts (${report.stale.count}): ${ids(report.stale)}`,
    `BLOCKED_EXTERNAL rows (${report.blocked.count}): ${ids(report.blocked)}`
  ].join('\n')}\n`
}

function writeReports(dir, json, markdown) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'release-decision.json'), `${JSON.stringify(json, null, 2)}\n`)
  writeFileSync(join(dir, 'release-decision.md'), markdown)
}

function main() {
  const { values } = parseArgs({
    options: {
      commit: { type: 'string', default: 'HEAD' },
      ledger: { type: 'string', default: 'ledger/tickets.json' },
      matrix: { type: 'string', default: 'traceability/matrix.json' },
      out: { type: 'string', default: DEFAULT_OUT },
      'detail-out': { type: 'string' }
    }
  })
  const releaseCommit = execFileSync('git', ['rev-parse', '--verify', `${values.commit}^{commit}`], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const decision = decide({
    ledgerPath: resolve(values.ledger),
    matrixPath: resolve(values.matrix),
    releaseCommit,
    foreignChanges: gitForeignChanges({ cwd: REPO_ROOT, releaseCommit })
  })
  const report = publicReport(decision)
  writeReports(resolve(values.out), report, renderPublicMarkdown(report))
  if (values['detail-out']) writeReports(resolve(values['detail-out']), decision, renderMarkdown(decision))
  process.stdout.write(`release decision ${decision.decision} on ${releaseCommit}\n`)
  process.exitCode = decision.decision === 'PASS' ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
