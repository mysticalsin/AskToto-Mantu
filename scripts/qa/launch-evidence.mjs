import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promotableAssets } from './provenance.mjs'

/** Ticket for the build-once candidate lane. The record only restates a PASS launch report. */
export const LAUNCH_EVIDENCE_TICKET = 'M2-0187'

/**
 * One PASS evidence line per promotable installer whose launch report matches the provenance bytes
 * and this candidate run. Missing or mismatched reports are problems; nothing is invented.
 */
export function evidenceFromLaunchReports(provenance, reports) {
  const problems = []
  const lines = []
  const byName = new Map()
  for (const report of reports) {
    if (report && typeof report === 'object' && typeof report.installer === 'string') {
      byName.set(report.installer, report)
    }
  }
  const runId = provenance?.run?.id
  for (const asset of promotableAssets(provenance)) {
    const report = byName.get(asset.name)
    if (!report) {
      problems.push(`no launch report for ${asset.name}`)
      continue
    }
    if (report.verdict !== 'PASS') {
      problems.push(`${asset.name} launch verdict is ${String(report.verdict)}`)
      continue
    }
    if (report.artifact_sha256 !== asset.sha256) {
      problems.push(`${asset.name} launch sha256 does not match provenance`)
      continue
    }
    if (report.candidate_run !== runId) {
      problems.push(`${asset.name} launch report is bound to run ${String(report.candidate_run)}, not ${String(runId)}`)
      continue
    }
    lines.push(
      JSON.stringify({
        ticket: LAUNCH_EVIDENCE_TICKET,
        result: 'PASS',
        build_run_id: runId,
        artifact_sha256: asset.sha256
      })
    )
  }
  return { lines, problems }
}

function readReports(directories) {
  const reports = []
  for (const directory of directories) {
    for (const name of readdirSync(directory)) {
      if (!name.endsWith('.json')) continue
      reports.push(JSON.parse(readFileSync(join(directory, name), 'utf8')))
    }
  }
  return reports
}

async function main(args) {
  const [provenancePath, outPath, ...directories] = args
  if (!provenancePath || !outPath || directories.length === 0) {
    console.error(
      'Usage: node scripts/qa/launch-evidence.mjs <provenance.json> <evidence.jsonl> <launch-report-dir>...'
    )
    process.exitCode = 2
    return
  }
  const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'))
  const { lines, problems } = evidenceFromLaunchReports(provenance, readReports(directories))
  if (problems.length > 0) {
    console.error(`Launch evidence rejected: ${JSON.stringify(problems)}`)
    process.exitCode = 1
    return
  }
  writeFileSync(outPath, `${lines.join('\n')}\n`)
  console.log(`Wrote ${lines.length} launch evidence lines for ${provenance.version}.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2))
