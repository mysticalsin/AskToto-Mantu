#!/usr/bin/env node
// Publish a bounded, privacy-safe summary of a strict hosted ST-1 report as a GitHub notice.
// This output is diagnostic only; the workflow's existing jq predicate remains the gate.
import { createHash } from 'node:crypto'
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_REPORT_BYTES = 4 * 1024 * 1024
const MAX_PROVENANCE_BYTES = 4 * 1024 * 1024
const ROWS = new Set(['fifo', 'none', 'synthetic-dataless'])
const VERDICTS = new Set(['PASS', 'FAIL', 'INCOMPLETE', 'NOT_EXERCISED'])
const CRITERIA = new Set([
  'inspector',
  'has-samples',
  'no-late-samples',
  'loop-p99 < 50',
  'loop-max < 250',
  'async-write < 250',
  'dns-lookup < 250',
  'non-regular-fixtures-unopened'
])
const UNAVAILABLE_REASONS = new Set([
  'arguments_invalid',
  'context_invalid',
  'report_missing',
  'report_unreadable',
  'report_too_large',
  'report_malformed',
  'report_context_mismatch',
  'report_schema_invalid'
])

function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!['--report', '--provenance', '--row'].includes(key) || !value || value.startsWith('--') || result[key]) {
      return null
    }
    result[key] = value
    index += 1
  }
  return result['--report'] && result['--provenance'] && result['--row'] ? result : null
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function boundedJson(path, limit) {
  let descriptor
  try {
    let beforePath
    try {
      beforePath = lstatSync(path, { bigint: true })
    } catch (error) {
      return { reason: error?.code === 'ENOENT' ? 'report_missing' : 'report_unreadable' }
    }
    if (!beforePath.isFile()) return { reason: 'report_unreadable' }
    if (beforePath.size > BigInt(limit)) return { reason: 'report_too_large' }

    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0)
    descriptor = openSync(path, flags)
    const beforeFile = fstatSync(descriptor, { bigint: true })
    if (!beforeFile.isFile() || !sameFileSnapshot(beforePath, beforeFile)) {
      return { reason: 'report_unreadable' }
    }

    const buffer = Buffer.alloc(limit + 1)
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const count = readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, bytesRead)
      if (count === 0) break
      bytesRead += count
      if (bytesRead > limit) return { reason: 'report_too_large' }
    }

    const afterFile = fstatSync(descriptor, { bigint: true })
    const afterPath = lstatSync(path, { bigint: true })
    if (
      !afterFile.isFile() ||
      !afterPath.isFile() ||
      !sameFileSnapshot(beforeFile, afterFile) ||
      !sameFileSnapshot(afterFile, afterPath) ||
      BigInt(bytesRead) !== afterFile.size
    ) {
      return { reason: 'report_unreadable' }
    }

    const bytes = buffer.subarray(0, bytesRead)
    return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
  } catch {
    return { reason: 'report_unreadable' }
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor)
      } catch {
        // A close failure is not safe to expose; the report is still never trusted by the gate.
      }
    }
  }
}

function sameFileSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

function parseJson(bytes) {
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    return undefined
  }
}

function contextFrom(env, provenance, row) {
  const workflowRunId = Number(env.GITHUB_RUN_ID)
  const workflowAttempt = Number(env.GITHUB_RUN_ATTEMPT)
  const commit = env.GITHUB_SHA
  const repository = env.GITHUB_REPOSITORY
  if (
    !ROWS.has(row) ||
    !Number.isSafeInteger(workflowRunId) ||
    workflowRunId < 1 ||
    String(workflowRunId) !== env.GITHUB_RUN_ID ||
    !Number.isSafeInteger(workflowAttempt) ||
    workflowAttempt < 1 ||
    String(workflowAttempt) !== env.GITHUB_RUN_ATTEMPT ||
    typeof commit !== 'string' ||
    !/^[0-9a-f]{40}$/.test(commit) ||
    typeof repository !== 'string' ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    provenance?.schema !== 2 ||
    provenance.repository !== repository ||
    provenance.commit !== commit ||
    provenance.run?.id !== workflowRunId ||
    provenance.run?.attempt !== workflowAttempt
  )
    return undefined

  if (!Array.isArray(provenance?.builds)) return undefined
  const qaBuilds = provenance.builds.filter((build) => build?.variant === 'mac-qa-identity')
  if (qaBuilds.length !== 1 || !Array.isArray(qaBuilds[0].assets) || qaBuilds[0].assets.length !== 1) return undefined
  const asset = qaBuilds[0].assets[0]
  if (
    typeof asset?.name !== 'string' ||
    !/^[A-Za-z0-9._-]+\.zip$/.test(asset.name) ||
    !/^[0-9a-f]{64}$/.test(asset.sha256 ?? '')
  ) {
    return undefined
  }
  return {
    workflowRunId,
    attempt: workflowAttempt,
    commit,
    row,
    candidateBuildRunId: workflowRunId,
    installer: asset.name,
    artifactSha256: asset.sha256
  }
}

function unavailable(reason, row, reportSha256) {
  const safeReason = UNAVAILABLE_REASONS.has(reason) ? reason : 'report_schema_invalid'
  return {
    schema: 1,
    state: 'unavailable',
    reason: safeReason,
    ...(ROWS.has(row) ? { row } : {}),
    reportSha256: /^[0-9a-f]{64}$/.test(reportSha256 ?? '') ? reportSha256 : null
  }
}

function reportSummary(report, context, reportSha256) {
  if (
    report?.harness !== 'ST-1' ||
    report.platform !== 'darwin' ||
    report.row !== context.row ||
    report.purpose != null ||
    report.st1Evidence === false ||
    report.build_run_id !== context.candidateBuildRunId ||
    report.installer !== context.installer ||
    report.artifact_sha256 !== context.artifactSha256 ||
    typeof report.complete !== 'boolean' ||
    !VERDICTS.has(report.verdict) ||
    !report.teardown ||
    typeof report.teardown.state !== 'string' ||
    !['acknowledged', 'unacknowledged', 'unknown'].includes(report.teardown.state) ||
    !Array.isArray(report.criteria) ||
    report.criteria.length === 0
  )
    return unavailable('report_context_mismatch', context.row, reportSha256)

  const criteria = []
  const seen = new Set()
  for (const criterion of report.criteria) {
    if (!CRITERIA.has(criterion?.name) || seen.has(criterion.name) || typeof criterion.pass !== 'boolean') {
      return unavailable('report_schema_invalid', context.row, reportSha256)
    }
    seen.add(criterion.name)
    criteria.push({ name: criterion.name, passed: criterion.pass })
  }

  const metrics = {}
  const addMetric = (name, actual, limit) => {
    if (finiteNumber(actual) !== undefined) metrics[name] = { actual, ...(limit === undefined ? {} : { limit }) }
  }
  addMetric('sampleCount', report.samples)
  addMetric('lateSampleCount', report.lateSamples, 0)
  addMetric('loopP99Ms', report.loop?.p99Ms, 50)
  addMetric('loopMaxMs', report.loop?.maxMs, 250)
  addMetric('asyncWriteMaxMs', report.write?.maxMs, 250)
  addMetric('dnsLookupMaxMs', report.lookup?.maxMs, 250)
  if (Array.isArray(report.fixturesOpened)) addMetric('openedFixtureCount', report.fixturesOpened.length, 0)

  const publicContext = {
    runId: context.workflowRunId,
    attempt: context.attempt,
    commit: context.commit,
    row: context.row
  }

  return {
    schema: 1,
    state: 'available',
    context: publicContext,
    mode: 'strict-hosted',
    verdict: report.verdict,
    complete: report.complete,
    teardownAcknowledged: report.teardown.state === 'acknowledged',
    criteria,
    metrics,
    reportSha256
  }
}

export function annotationMessage(value) {
  return `::notice::${JSON.stringify(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`
}

export function createNotice({ argv, env = process.env }) {
  const args = parseArgs(argv)
  const row = args?.['--row']
  if (!args) return unavailable('arguments_invalid', row)

  const provenanceFile = boundedJson(args['--provenance'], MAX_PROVENANCE_BYTES)
  const provenance = provenanceFile.bytes && parseJson(provenanceFile.bytes)
  const context = contextFrom(env, provenance, row)
  if (!context) return unavailable('context_invalid', row)

  const reportFile = boundedJson(args['--report'], MAX_REPORT_BYTES)
  if (!reportFile.bytes) return unavailable(reportFile.reason, row)
  const report = parseJson(reportFile.bytes)
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return unavailable('report_malformed', row, reportFile.sha256)
  }
  const summary = reportSummary(report, context, reportFile.sha256)
  if (summary.state === 'unavailable' && summary.reason === 'report_context_mismatch') {
    return {
      ...summary,
      context: { runId: context.workflowRunId, attempt: context.attempt, commit: context.commit, row: context.row }
    }
  }
  return summary
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const notice = createNotice({ argv: process.argv.slice(2) })
  process.stdout.write(`${annotationMessage(notice)}\n`)
}
