#!/usr/bin/env node
// Release decision (M2-0171): PASS/FAIL computed on one commit from the evidence registry and the
// traceability matrix, never asserted. PASS means engineering-complete; the real-environment column
// (rows waiting on an outside account, provider or QA machine) is reported beside it, not folded in.
//
//   node scripts/release/decide.mjs --commit HEAD [--ledger <tickets.json>] [--matrix <matrix.json>] [--out <dir>]
//
// The ledger, its evidence/records store and the matrix live in the private program checkout, so their
// paths are arguments. Missing or unreadable inputs are a FAIL, not a skip. Exit 0 = PASS, 1 = FAIL.
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
    lines.push(`- ${b.ticket} (${b.status}): ${b.inherited ? 'inherited from a dependency' : `owner ${b.owner}; unblock: ${b.unblock_step}; needed by ${b.needed_by}`}`)
  }
  return `${lines.join('\n')}\n`
}

function main() {
  const { values } = parseArgs({
    options: {
      commit: { type: 'string', default: 'HEAD' },
      ledger: { type: 'string', default: 'ledger/tickets.json' },
      matrix: { type: 'string', default: 'traceability/matrix.json' },
      out: { type: 'string', default: DEFAULT_OUT }
    }
  })
  const releaseCommit = execFileSync('git', ['rev-parse', '--verify', `${values.commit}^{commit}`], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const decision = decide({
    ledgerPath: resolve(values.ledger),
    matrixPath: resolve(values.matrix),
    releaseCommit,
    foreignChanges: gitForeignChanges({ cwd: REPO_ROOT, releaseCommit })
  })
  const outDir = resolve(values.out)
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'release-decision.json'), `${JSON.stringify(decision, null, 2)}\n`)
  writeFileSync(join(outDir, 'release-decision.md'), renderMarkdown(decision))
  process.stdout.write(`release decision ${decision.decision} on ${releaseCommit}\n`)
  process.exitCode = decision.decision === 'PASS' ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
