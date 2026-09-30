#!/usr/bin/env node
/**
 * Content-free M2-0205 packaged evidence manifest.
 *
 * This tool is intentionally not a product simulator. The reversible ledger truth table is covered by
 * repository behavior tests; the packaged QA-account run needs a real candidate install/profile owner.
 * Hosted CI records the candidate artifact identity and the exact lead action instead of claiming a
 * live QA-account pass it did not perform.
 *
 * Usage: node scripts/qa/m2-0205-ledger-rollout-report.mjs <candidate-path> <report.json>
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

function usage() {
  console.error('Usage: node scripts/qa/m2-0205-ledger-rollout-report.mjs <candidate-path> <report.json>')
  process.exit(2)
}

const [candidateArg, reportArg] = process.argv.slice(2)
if (!candidateArg || !reportArg) usage()

const candidatePath = resolve(candidateArg)
const reportPath = resolve(reportArg)

let candidate
try {
  const st = statSync(candidatePath)
  if (st.isFile()) {
    const bytes = readFileSync(candidatePath)
    candidate = {
      kind: 'file',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: st.size
    }
  } else if (st.isDirectory()) {
    candidate = {
      kind: 'directory',
      sha256: null,
      size: null
    }
  } else {
    candidate = { kind: 'other', sha256: null, size: null }
  }
} catch (error) {
  candidate = {
    kind: 'missing',
    sha256: null,
    size: null,
    error: error instanceof Error ? error.message : String(error)
  }
}

const report = {
  schema: 'metis.m2-0205.ledger-rollout.v1',
  generated_at: new Date().toISOString(),
  candidate,
  rows: [
    {
      id: 'truth-table-legacy-expand-switch',
      status: 'CI_TEST',
      evidence: 'src/main/infra/storage/ingest-ledger.test.ts'
    },
    {
      id: 'packaged-expand-switch-rollback-qa-account',
      status: 'LEAD_ACTION',
      unblock: 'Run the packaged candidate on the QA account for legacy, expand and switch modes, then attach the produced report artifact with this candidate sha256.'
    }
  ]
}

mkdirSync(dirname(reportPath), { recursive: true })
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
console.log(`wrote ${reportPath}`)
