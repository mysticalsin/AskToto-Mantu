#!/usr/bin/env node
// Growth analyzer (M2-0488): judges a census-stream/1 NDJSON and its audit-counts/1 file against a
// pre-registered rule in growth-rule.mjs (IDLE-GROWTH-1 or MEETING-GROWTH-1; the clauses are stated there).
//
//   node scripts/qa/soak/growth.mjs --samples <ndjson> --audit-counts <json> --rule <id> --out <verdict.json>
//     [--capture-start-ms <ms>] [--stop-ms <ms>]    (MEETING-GROWTH-1 only; stream time, default 0 and +60 min)
//
// Exit codes: 0 PASS, 1 FAIL, 2 INCOMPLETE (also 2, with no verdict written, on a usage or read error).
// The verdict is content-free: numbers, kinds, check ids, event names and hashes; never paths or text.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { RULE_IDS, rulesSha256 } from './growth-rule.mjs'

export const VERDICT_SCHEMA = 'growth-verdict/1'
export const EXIT_CODES = Object.freeze({ PASS: 0, FAIL: 1, INCOMPLETE: 2 })

const STREAM_SCHEMA = 'census-stream/1'
const AUDIT_COUNTS_SCHEMA = 'audit-counts/1'
const MIB = 1024 * 1024
const MINUTE_MS = 60_000
const RULE_FILE = new URL('./growth-rule.mjs', import.meta.url)

/** Check families a rule must evaluate before it may report PASS. */
export const REQUIRED_CHECKS = Object.freeze({
  'IDLE-GROWTH-1': Object.freeze(['P1', 'P2', 'P2-SPAWN', 'M1', 'M2', 'C1', 'J1-RISE', 'J1-BUCKET']),
  'MEETING-GROWTH-1': Object.freeze(['P1', 'P2', 'P2-SPAWN', 'POST', 'M1', 'POST-M', 'J1-BUCKET'])
})

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const sum = (values) => values.reduce((total, value) => total + value, 0)

export function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Median of the pairwise slopes; 0 with fewer than two distinct x values. */
export function theilSenSlope(points) {
  const slopes = []
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const dx = points[j].x - points[i].x
      if (dx !== 0) slopes.push((points[j].y - points[i].y) / dx)
    }
  }
  return median(slopes) ?? 0
}

/** PASS only when every validity clause and every required check family was evaluated and passed. */
export function decideOutcome({ validity, checks, required }) {
  if (validity.some((clause) => clause.id === 'V-MAIN' && clause.pass === false)) return 'FAIL'
  if (validity.length === 0 || validity.some((clause) => clause.pass !== true)) return 'INCOMPLETE'
  if (checks.some((check) => check.pass === false)) return 'FAIL'
  const families = new Set(checks.map((check) => check.id))
  if (checks.some((check) => check.pass !== true) || required.some((id) => !families.has(id))) return 'INCOMPLETE'
  return 'PASS'
}

function parseStream(text) {
  let header = null
  let trailer = null
  let unparseableLines = 0
  const records = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      unparseableLines += 1
      continue
    }
    if (record?.record === 'header' && header === null) header = record
    else if (record?.record === 'sample' && Number.isFinite(record.tMs)) records.push(record)
    else if (record?.record === 'trailer') trailer = record
    else unparseableLines += 1
  }
  records.sort((a, b) => a.tMs - b.tMs)
  return { header, trailer, records, unparseableLines }
}

function modelSample(record, rule, metric) {
  const counts = Object.fromEntries(rule.kinds.map((kind) => [kind, 0]))
  const memory = Object.fromEntries(rule.kinds.map((kind) => [kind, 0]))
  const processes = []
  let complete = true
  for (const process of Array.isArray(record.processes) ? record.processes : []) {
    const kind = rule.kinds.includes(process?.kind) ? process.kind : 'other'
    counts[kind] += 1
    const bytes = process?.[metric]
    if (Number.isFinite(bytes)) memory[kind] += bytes
    else complete = false
    processes.push({ key: `${process?.pid}:${process?.startedMs}`, kind, cpuSeconds: process?.cpuSeconds })
  }
  return {
    t: record.tMs,
    complete,
    counts,
    memory,
    total: sum(Object.values(memory)),
    runtimes: sum(rule.supervisedRuntimeKinds.map((kind) => counts[kind])),
    processes
  }
}

const inRange = (samples, from, to) => samples.filter((sample) => sample.t >= from && sample.t < to)

/** 10-min buckets over [from, to); the final bucket may be shorter. */
function bucketize(samples, from, to, widthMs) {
  const buckets = []
  for (let start = from; start < to; start += widthMs) {
    const end = Math.min(start + widthMs, to)
    buckets.push({ start, end, samples: inRange(samples, start, end) })
  }
  return buckets
}

const bucketMedian = (bucket, value) => median(bucket.samples.map(value))
const bucketTime = (bucket) => median(bucket.samples.map((sample) => sample.t))

function referenceCounts(bucket, rule) {
  return Object.fromEntries(rule.kinds.map((kind) => [kind, bucketMedian(bucket, (sample) => sample.counts[kind])]))
}

/** A sidecar-supervisor wrapper is allowed alongside each supervised runtime the bounds allow in that bucket. */
function countBound(kind, bucket, bounds, rule) {
  if (kind !== rule.supervisorKind) return bounds[kind]
  const runtimeBound = sum(rule.supervisedRuntimeKinds.map((runtime) => bounds[runtime]))
  const runtimes = bucketMedian(bucket, (sample) => sample.runtimes)
  return Math.max(bounds[kind], Math.min(runtimes, runtimeBound))
}

/** Per kind: the bucket with the largest excess over its bound (the first bucket when none exceeds it). */
function countChecks(id, buckets, bounds, rule) {
  return rule.kinds.map((kind) => {
    let worst = null
    for (const bucket of buckets) {
      const measured = bucketMedian(bucket, (sample) => sample.counts[kind])
      const bound = countBound(kind, bucket, bounds, rule)
      if (worst === null || measured - bound > worst.measured - worst.bound) {
        worst = { measured, bound, bucketStartMinute: bucket.start / MINUTE_MS }
      }
    }
    return { id, subject: kind, unit: 'processes', ...worst, pass: worst.measured <= worst.bound }
  })
}

function identityChecks(samples, reference, rule) {
  const identities = Object.fromEntries(rule.kinds.map((kind) => [kind, new Set()]))
  for (const sample of samples) for (const process of sample.processes) identities[process.kind].add(process.key)
  const runtimeReference = sum(rule.supervisedRuntimeKinds.map((kind) => reference[kind]))
  return rule.kinds.map((kind) => {
    const base = kind === rule.supervisorKind ? Math.max(reference[kind], runtimeReference) : reference[kind]
    const measured = identities[kind].size
    const bound = base + rule.p2.extraIdentitiesPerKind
    return { id: 'P2', subject: kind, unit: 'identities', measured, bound, pass: measured <= bound }
  })
}

function memoryBound(limit, referenceBytes) {
  return Math.max(limit.floorMiB * MIB, limit.fraction * referenceBytes)
}

function memorySeries(rule) {
  return [
    { subject: 'total', value: (sample) => sample.total },
    ...rule.kinds.map((kind) => ({ subject: kind, value: (sample) => sample.memory[kind] }))
  ]
}

function jobEvents(counts, rule) {
  let total = 0
  for (const [key, count] of Object.entries(counts ?? {})) {
    if (rule.jobEvents.some((name) => key === name || key.startsWith(`${name}:`))) total += Number(count) || 0
  }
  return total
}

/** Audit buckets whose midpoint lies in [from, to), in order, with zero for buckets the file omits. */
function auditWindow(audit, offsetMs, from, to) {
  const widthMs = audit.bucketMinutes * MINUTE_MS
  const byIndex = new Map(audit.buckets.map((bucket) => [bucket.index, bucket.counts]))
  const result = []
  for (let index = 0; offsetMs + (index + 0.5) * widthMs < to; index += 1) {
    const mid = offsetMs + (index + 0.5) * widthMs
    if (mid >= from) result.push({ index, counts: byIndex.get(index) ?? {} })
  }
  return result
}

function cpuPercent(samples) {
  if (samples.length < 2) return null
  const observed = new Map()
  for (const sample of samples) {
    for (const process of sample.processes) {
      if (!Number.isFinite(process.cpuSeconds)) continue
      const seen = observed.get(process.key)
      if (seen) seen.last = process.cpuSeconds
      else observed.set(process.key, { first: process.cpuSeconds, last: process.cpuSeconds })
    }
  }
  const wallSeconds = (samples.at(-1).t - samples[0].t) / 1000
  if (!(wallSeconds > 0)) return null
  const cpuSeconds = sum([...observed.values()].map((seen) => Math.max(0, seen.last - seen.first)))
  return (100 * cpuSeconds) / wallSeconds
}

const clause = (id, measured, bound, pass) => ({ id, measured, bound, pass })

const memoryMetricFor = (rule, header) =>
  Object.hasOwn(rule.memoryMetric, String(header?.platform)) ? rule.memoryMetric[header.platform] : null

function commonValidity({ stream, audit, rule, samples }) {
  const validity = []
  const header = stream.header
  const metric = memoryMetricFor(rule, header)
  validity.push(clause('V-STREAM', header?.schema ?? null, STREAM_SCHEMA, header?.schema === STREAM_SCHEMA && Boolean(metric)))
  validity.push(clause('V-INTERVAL', header?.intervalMs ?? null, rule.samplingSeconds * 1000, header?.intervalMs === rule.samplingSeconds * 1000))
  const offsetMs = Date.parse(audit?.from) - Date.parse(header?.startedAt)
  validity.push(
    clause(
      'V-AUDIT',
      Number.isFinite(offsetMs) ? offsetMs / 1000 : null,
      rule.audit.alignSeconds,
      audit?.schema === AUDIT_COUNTS_SCHEMA &&
        audit.bucketMinutes === rule.audit.bucketMinutes &&
        Array.isArray(audit.buckets) &&
        Math.abs(offsetMs) <= rule.audit.alignSeconds * 1000
    )
  )
  const notAlive = stream.records.filter((record) => record.mainAlive !== true).length
  const mainExited = notAlive > 0 || stream.trailer?.outcome === 'main-exited'
  // An empty stream is INCOMPLETE through V-SAMPLES; only an observed main exit is FAIL.
  validity.push(clause('V-MAIN', notAlive, 0, !mainExited))
  if (samples.length > 0) {
    const first = samples[0].t
    const last = samples.at(-1).t
    const planned = Math.floor((last - first) / (rule.samplingSeconds * 1000)) + 1
    const complete = samples.filter((sample) => sample.complete).length
    validity.push(clause('V-SAMPLES', complete / planned, rule.validity.minSampleFraction, complete / planned >= rule.validity.minSampleFraction))
  } else {
    validity.push(clause('V-SAMPLES', 0, rule.validity.minSampleFraction, false))
  }
  return { validity, offsetMs }
}

function emptyBucketsClause(buckets) {
  const empty = buckets.filter((bucket) => bucket.samples.length === 0).length
  return clause('V-BUCKETS', empty, 0, empty === 0)
}

function idleChecks({ rule, samples, audit, offsetMs }) {
  const widthMs = rule.bucketMinutes * MINUTE_MS
  const settleEnd = rule.settleMinutes * MINUTE_MS
  const lastT = samples.at(-1).t
  const reference = bucketize(samples, Math.max(0, settleEnd - widthMs), settleEnd, widthMs)[0]
  const buckets = bucketize(samples, settleEnd, lastT + 1, widthMs)
  const validity = [
    clause('V-DURATION', (lastT - settleEnd) / MINUTE_MS, rule.validity.minMinutesAfterSettle, lastT - settleEnd >= rule.validity.minMinutesAfterSettle * MINUTE_MS),
    emptyBucketsClause([reference, ...buckets])
  ]
  if (validity.some((entry) => !entry.pass)) return { validity, checks: [] }

  const refCounts = referenceCounts(reference, rule)
  const window = inRange(samples, settleEnd, lastT + 1)
  const auditBuckets = auditWindow(audit, offsetMs, settleEnd, lastT + 1)
  const spawns = sum(auditBuckets.map((bucket) => Number(bucket.counts['sidecar.spawn']) || 0))
  const checks = [
    ...countChecks('P1', buckets, refCounts, rule),
    ...identityChecks(window, refCounts, rule),
    { id: 'P2-SPAWN', subject: 'sidecar.spawn', unit: 'events', measured: spawns, bound: rule.p2.maxSidecarSpawns, pass: spawns <= rule.p2.maxSidecarSpawns }
  ]

  const projectionMs = (rule.m1.projectToMinutesAfterLaunch - rule.settleMinutes) * MINUTE_MS
  const projection = { fromMinute: rule.settleMinutes, toMinute: rule.m1.projectToMinutesAfterLaunch, series: {} }
  for (const series of memorySeries(rule)) {
    const limit = series.subject === 'total' ? rule.m1.total : rule.m1.perKind
    const referenceBytes = bucketMedian(reference, series.value)
    const bound = memoryBound(limit, referenceBytes)
    const slope = theilSenSlope(buckets.map((bucket) => ({ x: bucketTime(bucket), y: bucketMedian(bucket, series.value) })))
    const projected = slope * projectionMs
    projection.series[series.subject] = {
      referenceBytes,
      slopeBytesPerHour: slope * 60 * MINUTE_MS,
      projectedGrowthBytes: projected,
      projectedBytesAtEnd: referenceBytes + projected
    }
    checks.push({ id: 'M1', subject: series.subject, unit: 'bytes', measured: projected, bound, pass: projected <= bound })
    const step = bucketMedian(buckets.at(-1), series.value) - bucketMedian(buckets[0], series.value)
    checks.push({ id: 'M2', subject: series.subject, unit: 'bytes', measured: step, bound, pass: step <= bound })
  }

  const windowMs = rule.c1.windowMinutes * MINUTE_MS
  const firstCpu = cpuPercent(inRange(samples, settleEnd, settleEnd + windowMs + 1))
  const lastCpu = cpuPercent(inRange(samples, lastT - windowMs, lastT + 1))
  if (firstCpu !== null && lastCpu !== null) {
    const bound = firstCpu + rule.c1.maxRisePoints
    checks.push({ id: 'C1', subject: 'one-core-cpu', unit: 'percent', measured: lastCpu, bound, firstWindow: firstCpu, pass: lastCpu <= bound })
  }

  const jobs = auditBuckets.map((bucket) => jobEvents(bucket.counts, rule))
  const firstJobs = sum(jobs.slice(0, rule.j1.windowBuckets))
  const lastJobs = sum(jobs.slice(-rule.j1.windowBuckets))
  checks.push({ id: 'J1-RISE', subject: 'job-events', unit: 'events', measured: lastJobs, bound: firstJobs + rule.j1.maxRiseEvents, firstWindow: firstJobs, pass: lastJobs <= firstJobs + rule.j1.maxRiseEvents })
  const maxJobs = Math.max(0, ...jobs)
  checks.push({ id: 'J1-BUCKET', subject: 'job-events', unit: 'events', measured: maxJobs, bound: rule.j1.maxPerBucket, pass: maxJobs <= rule.j1.maxPerBucket })
  return { validity, checks, projection }
}

function meetingChecks({ rule, samples, audit, offsetMs, captureStartMs, stopMs }) {
  const widthMs = rule.bucketMinutes * MINUTE_MS
  const settleEnd = captureStartMs + rule.settleMinutes * MINUTE_MS
  const lastT = samples.at(-1).t
  const capture = inRange(samples, captureStartMs, stopMs)
  const captured = capture.length > 0 ? capture.at(-1).t - captureStartMs : 0
  const reference = bucketize(samples, Math.max(captureStartMs, settleEnd - widthMs), settleEnd, widthMs)[0]
  const buckets = bucketize(samples, settleEnd, stopMs, widthMs)
  const post = bucketize(samples, stopMs, lastT + 1, widthMs)
  const postSamples = inRange(samples, stopMs, lastT + 1).length
  const validity = [
    clause('V-DURATION', captured / MINUTE_MS, rule.validity.minCaptureMinutes, captured >= rule.validity.minCaptureMinutes * MINUTE_MS),
    clause('V-POST', postSamples, 1, postSamples >= 1),
    emptyBucketsClause([reference, ...buckets, ...post])
  ]
  if (validity.some((entry) => !entry.pass)) return { validity, checks: [] }

  const refCounts = referenceCounts(reference, rule)
  const checks = []
  const preCapture = inRange(samples, captureStartMs - rule.p0.preCaptureMinutes * MINUTE_MS, captureStartMs)
  if (preCapture.length > 0) {
    const pre = { samples: preCapture }
    const preCounts = referenceCounts(pre, rule)
    const runtimeRise = Math.max(0, bucketMedian(reference, (sample) => sample.runtimes) - bucketMedian(pre, (sample) => sample.runtimes))
    for (const kind of rule.kinds) {
      if (rule.p0.mayAppearBeforeSettleEnd.includes(kind)) continue
      const bound = kind === rule.supervisorKind ? preCounts[kind] + runtimeRise : preCounts[kind]
      checks.push({ id: 'P0', subject: kind, unit: 'processes', measured: refCounts[kind], bound, pass: refCounts[kind] <= bound })
    }
  }
  const auditCapture = auditWindow(audit, offsetMs, captureStartMs, stopMs)
  const spawns = sum(auditWindow(audit, offsetMs, settleEnd, stopMs).map((bucket) => Number(bucket.counts['sidecar.spawn']) || 0))
  const postBounds = Object.fromEntries(rule.kinds.map((kind) => [kind, refCounts[kind] + (rule.postMeeting.extraCounts[kind] ?? 0)]))
  checks.push(
    ...countChecks('P1', buckets, refCounts, rule),
    ...identityChecks(inRange(samples, settleEnd, stopMs), refCounts, rule),
    { id: 'P2-SPAWN', subject: 'sidecar.spawn', unit: 'events', measured: spawns, bound: rule.p2.maxSidecarSpawns, pass: spawns <= rule.p2.maxSidecarSpawns },
    ...countChecks('POST', post, postBounds, rule)
  )

  const growthMs = (rule.captureMinutes - rule.settleMinutes) * MINUTE_MS
  let totalBound = null
  for (const series of memorySeries(rule)) {
    const limit = series.subject === 'total' ? rule.m1.total : (rule.m1.kindOverrides[series.subject] ?? rule.m1.perKind)
    const referenceBytes = bucketMedian(reference, series.value)
    const bound = memoryBound(limit, referenceBytes)
    if (series.subject === 'total') totalBound = { referenceBytes, bound }
    const slope = theilSenSlope(buckets.map((bucket) => ({ x: bucketTime(bucket), y: bucketMedian(bucket, series.value) })))
    const growth = slope * growthMs
    checks.push({ id: 'M1', subject: series.subject, unit: 'bytes', measured: growth, bound, pass: growth <= bound })
  }
  const postEnd = bucketMedian(post.at(-1), (sample) => sample.total)
  const postBound = totalBound.referenceBytes + totalBound.bound
  checks.push({ id: 'POST-M', subject: 'total', unit: 'bytes', measured: postEnd, bound: postBound, pass: postEnd <= postBound })

  const maxJobs = Math.max(0, ...auditCapture.map((bucket) => jobEvents(bucket.counts, rule)))
  checks.push({ id: 'J1-BUCKET', subject: 'job-events', unit: 'events', measured: maxJobs, bound: rule.j1.maxPerBucket, pass: maxJobs <= rule.j1.maxPerBucket })
  return { validity, checks }
}

function parseAudit(bytes) {
  try {
    return JSON.parse(String(bytes))
  } catch {
    return null
  }
}

/**
 * Judges one leg. `samples` and `auditCounts` are the input files' bytes. Meeting times are stream
 * milliseconds (the census stream's tMs).
 * @param {{ ruleId: string, samples: Buffer | string, auditCounts: Buffer | string, captureStartMs?: number, stopMs?: number, ruleFileBytes?: Buffer }} options
 */
export function evaluateGrowth({ ruleId, samples, auditCounts, captureStartMs = 0, stopMs = undefined, ruleFileBytes = readFileSync(RULE_FILE) }) {
  const rule = RULE_IDS[ruleId]
  if (!rule) throw new Error(`unknown rule: ${ruleId} (expected ${Object.keys(RULE_IDS).join(' or ')})`)
  const stream = parseStream(String(samples))
  const audit = parseAudit(auditCounts)
  const metric = memoryMetricFor(rule, stream.header)
  const modelled = metric ? stream.records.map((record) => modelSample(record, rule, metric)) : []
  const stop = stopMs ?? captureStartMs + rule.captureMinutes * MINUTE_MS
  const common = commonValidity({ stream, audit, rule, samples: modelled })
  let validity = common.validity
  let checks = []
  let projection
  const usable = modelled.filter((sample) => sample.complete)
  if (validity.every((entry) => entry.pass) && usable.length > 0) {
    const result =
      rule.id === 'IDLE-GROWTH-1'
        ? idleChecks({ rule, samples: usable, audit, offsetMs: common.offsetMs })
        : meetingChecks({
            rule,
            samples: usable,
            audit,
            offsetMs: common.offsetMs,
            captureStartMs,
            stopMs: stop
          })
    validity = [...validity, ...result.validity]
    checks = result.checks
    projection = result.projection
  }
  const outcome = decideOutcome({ validity, checks, required: REQUIRED_CHECKS[rule.id] })
  return {
    schema: VERDICT_SCHEMA,
    outcome,
    rule: { id: rule.id, rulesSha256: rulesSha256(), file: 'growth-rule.mjs', fileSha256: sha256(ruleFileBytes) },
    inputs: { samples: { sha256: sha256(samples) }, auditCounts: { sha256: sha256(auditCounts) } },
    platform: stream.header?.platform ?? null,
    memoryMetric: metric ?? null,
    ...(rule.id === 'MEETING-GROWTH-1' ? { captureStartMs, stopMs: stop } : {}),
    samples: { records: stream.records.length, complete: usable.length, unparseableLines: stream.unparseableLines },
    validity,
    checks,
    failed: [...validity, ...checks].filter((entry) => entry.pass === false).map((entry) => (entry.subject ? `${entry.id}:${entry.subject}` : entry.id)),
    ...(projection ? { projection } : {}),
    residual: rule.residual
  }
}

function readArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      samples: { type: 'string' },
      'audit-counts': { type: 'string' },
      rule: { type: 'string' },
      out: { type: 'string' },
      'capture-start-ms': { type: 'string' },
      'stop-ms': { type: 'string' }
    },
    strict: true
  })
  if (!values.samples || !values['audit-counts'] || !values.rule || !values.out) {
    throw new Error('Usage: growth.mjs --samples <ndjson> --audit-counts <json> --rule <id> --out <verdict.json> [--capture-start-ms <ms>] [--stop-ms <ms>]')
  }
  const number = (name) => {
    if (values[name] === undefined) return undefined
    const value = Number(values[name])
    if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} must be a non-negative number`)
    return value
  }
  return { ...values, captureStartMs: number('capture-start-ms') ?? 0, stopMs: number('stop-ms') }
}

function main() {
  const args = readArgs(process.argv.slice(2))
  const verdict = evaluateGrowth({
    ruleId: args.rule,
    samples: readFileSync(args.samples),
    auditCounts: readFileSync(args['audit-counts']),
    captureStartMs: args.captureStartMs,
    stopMs: args.stopMs
  })
  mkdirSync(dirname(args.out), { recursive: true })
  const temp = `${args.out}.tmp`
  writeFileSync(temp, `${JSON.stringify(verdict, null, 2)}\n`, 'utf8')
  renameSync(temp, args.out)
  console.log(`[growth] ${verdict.rule.id} ${verdict.outcome}${verdict.failed.length ? ` (${verdict.failed.join(', ')})` : ''}`)
  return EXIT_CODES[verdict.outcome]
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = main()
  } catch (error) {
    console.error(`[growth] ${error?.message ?? error}`)
    process.exitCode = EXIT_CODES.INCOMPLETE
  }
}
