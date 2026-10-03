#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const AUDIT_COUNTS_SCHEMA = 'audit-counts/1'

// Basename of a rotated audit generation (`audit-<epoch-ms>.log`); mirrors AUDIT_ARCHIVE_PATTERN in
// src/main/logger.ts.
const ARCHIVE_PATTERN = /^audit-(\d+)\.log$/

/** The only event names that leave this tool. Everything else is folded into one `other` count. */
export const COUNTED_EVENTS = [
  'brain.ingest',
  'brain.backfill.start',
  'brain.consolidation',
  'brain.intelligencePass.start',
  'brain.intelligence_index',
  'mcp.push.queued',
  'mcp.push.retried',
  'local.runtime.start',
  'local.runtime.stop',
  'local.runtime.crash',
  'local.runtime.restart',
  'sidecar.spawn',
  'sidecar.exit',
  'sidecar.reaped',
  'app.stall',
  'history.request'
]

const SCHEDULER_JOB = 'scheduler.job'
// scheduler.job carries an outcome enum; anything that is not a short enum-shaped token is not copied.
const OUTCOME_ENUM = /^[a-z][a-z0-9_-]{0,31}$/

function eventKey(record) {
  const event = record.event
  if (event === SCHEDULER_JOB) {
    const outcome = typeof record.outcome === 'string' && OUTCOME_ENUM.test(record.outcome) ? record.outcome : 'unknown'
    return `${SCHEDULER_JOB}:${outcome}`
  }
  return COUNTED_EVENTS.includes(event) ? event : null
}

/** Rotated generations oldest first (by epoch stamp), then the live file. */
export function auditFilesInOrder(userData) {
  const dir = join(userData, 'logs')
  if (!existsSync(dir)) return []
  const archives = readdirSync(dir)
    .map((name) => ({ name, match: ARCHIVE_PATTERN.exec(name) }))
    .filter((entry) => entry.match)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]))
    .map((entry) => join(dir, entry.name))
  const live = join(dir, 'audit.log')
  return existsSync(live) ? [...archives, live] : archives
}

/**
 * Per-bucket counts of allowlisted audit events. Only event names, scheduler outcome enums and counts are
 * produced; actor, detail fields, file names and text are never copied. Unparseable lines (a torn last
 * line) are skipped and tallied.
 */
export function countAuditEvents({ userData, from, bucketMinutes }) {
  const fromMs = Date.parse(from)
  if (!Number.isFinite(fromMs)) throw new Error('--from must be an ISO timestamp')
  if (!(bucketMinutes > 0)) throw new Error('--bucket-minutes must be positive')
  const bucketMs = bucketMinutes * 60_000
  const buckets = new Map()
  let unparseableLines = 0
  for (const file of auditFilesInOrder(userData)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      let record
      try {
        record = JSON.parse(line)
      } catch {
        unparseableLines += 1
        continue
      }
      const tsMs = Date.parse(record?.ts)
      if (!Number.isFinite(tsMs) || tsMs < fromMs) continue
      const index = Math.floor((tsMs - fromMs) / bucketMs)
      const bucket = buckets.get(index) ?? { counts: {}, other: 0 }
      buckets.set(index, bucket)
      const key = eventKey(record)
      if (key === null) bucket.other += 1
      else bucket.counts[key] = (bucket.counts[key] ?? 0) + 1
    }
  }
  return {
    schema: AUDIT_COUNTS_SCHEMA,
    from: new Date(fromMs).toISOString(),
    bucketMinutes,
    unparseableLines,
    buckets: [...buckets.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, bucket]) => ({
        index,
        startsAt: new Date(fromMs + index * bucketMs).toISOString(),
        counts: Object.fromEntries(Object.entries(bucket.counts).sort(([a], [b]) => a.localeCompare(b))),
        other: bucket.other
      }))
  }
}

/** Writes via a temp file and rename so a run killed mid-write never leaves a truncated counts file. */
export function writeAuditCounts(path, options) {
  const counts = countAuditEvents(options)
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.tmp`
  writeFileSync(temp, `${JSON.stringify(counts, null, 2)}\n`, 'utf8')
  renameSync(temp, path)
  return counts
}

function readArgs(argv) {
  const args = { bucketMinutes: 10 }
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      i += 1
      if (i >= argv.length) throw new Error(`${arg} requires a value`)
      return argv[i]
    }
    if (arg === '--from') args.from = next()
    else if (arg === '--bucket-minutes') args.bucketMinutes = Number(next())
    else if (arg === '--out') args.out = next()
    else if (arg.startsWith('--')) throw new Error(`unknown argument: ${arg}`)
    else positional.push(arg)
  }
  args.userData = positional[0]
  return args
}

function main() {
  const args = readArgs(process.argv.slice(2))
  if (!args.userData || !args.from || !args.out) {
    throw new Error('Usage: audit-counts.mjs <userData> --from <iso> [--bucket-minutes <n>] --out <json>')
  }
  writeAuditCounts(args.out, { userData: args.userData, from: args.from, bucketMinutes: args.bucketMinutes })
  console.log(`[audit-counts] wrote ${args.out}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main()
  } catch (error) {
    console.error(`[audit-counts] ${error?.message ?? error}`)
    process.exitCode = 1
  }
}
