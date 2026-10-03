// Owner-soak evaluator (M2-0479, the scripts half of M2-0198).
//
// Turns the schema-2 diagnostics summary the owner pastes on day five into the content-free MEASURED
// record for the 1.9.7 soak, and applies the rule below. Under D-28 this runs only in GitHub Actions.
//
// PRE-REGISTERED RULE soak-rule-1 (written before any real data; changing it means a new rule id):
//   Eligible  : kind is 'metis-diagnostics-summary', schema is 2, app.version and scope.version are
//               1.9.7, the audit read was not truncated, and the scope holds at least five consecutive
//               UTC days that each carry a record (a day with no record is idle and breaks the run).
//   PROCEED   : all five counts over the version scope are zero:
//                 stallsOver5s, uncleanShutdowns, orphanReaps (registry + legacy-orphan),
//                 revealNoOps, brainIndexQuarantined.
//   HOLD      : any of the five is above zero. HOLD means investigate before release, not failure.
//   Ineligible: no verdict and no record; the summary cannot support a MEASURED claim.
// The record holds UTC dates and counts only: no paths, names, meeting content or raw audit lines.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

export const SOAK_RULE_ID = 'soak-rule-1'
export const SOAK_VERSION = '1.9.7'
export const MIN_CONSECUTIVE_DAYS = 5
export const RECORD_FILE = 'soak-5d.md'
export const HISTORY_RULE_ID = 'history-rule-1'
export const HISTORY_MIN_VERSION = '1.9.9'
export const HISTORY_RECORD_FILE = 'history-m2-0067.md'
export const HISTORY_DEFAULT_MIN_NOT_DOWNLOADED_REQUESTS = 3
export const HISTORY_P95_LIMITS_MS = Object.freeze({
  queue_ms: 250,
  main_ms: 1000,
  ipc_ms: 250,
  render_ms: 1000,
  total_ms: 2500
})
export const DEFAULT_OUT_DIR = 'out/owner-soak'

// PRE-REGISTERED RULE history-rule-1: the default minimum is part of the rule; dispatch may only raise it.
const DAY_MS = 24 * 60 * 60 * 1000
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const USER_PATH_RE = /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^\s/\\]+/i
const EMAIL_RE = /[^\s@<>]+@[^\s@<>]+\.[A-Za-z]{2,}/
const SHA256_RE = /^[a-f0-9]{64}$/i

const isCount = (value) => Number.isInteger(value) && value >= 0
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The five acceptance counts; a PROCEED needs every one of them to be zero. */
export const COUNT_KEYS = Object.freeze([
  'stalls_over_5s', 'unclean_shutdowns', 'orphan_reaps', 'reveal_no_ops', 'brain_index_quarantined'
])

export function verdictFor(counts) {
  return COUNT_KEYS.every((key) => counts[key] === 0) ? 'PROCEED' : 'HOLD'
}

const activeDay = (day) => isPlainObject(day) && isCount(day.records) && day.records > 0

/** Longest run of consecutive UTC days that carry at least one record; null when there is none. */
export function longestActiveRun(days) {
  const keys = Object.keys(days).filter((key) => DAY_RE.test(key) && !Number.isNaN(Date.parse(key)) && activeDay(days[key])).sort()
  let best = null
  let start = null
  for (let i = 0; i < keys.length; i++) {
    const consecutive = i > 0 && Date.parse(keys[i]) - Date.parse(keys[i - 1]) === DAY_MS
    if (!consecutive) start = i
    if (!best || i - start + 1 > best.length) best = { first: keys[start], last: keys[i], length: i - start + 1 }
  }
  return best
}

function countsOf(soak, problems) {
  const reaps = soak?.orphanReaps
  const raw = {
    stalls_over_5s: soak?.stallsOver5s,
    unclean_shutdowns: soak?.uncleanShutdowns,
    orphan_reaps_registry: reaps?.registry,
    orphan_reaps_legacy: reaps?.['legacy-orphan'],
    orphan_reaps_after_unclean_exit: reaps?.afterUncleanExit,
    reveal_no_ops: soak?.revealNoOps,
    brain_index_quarantined: soak?.brainIndexQuarantined
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!isCount(value)) problems.push(`scope.soak: ${key} must be a non-negative integer`)
  }
  return {
    stalls_over_5s: raw.stalls_over_5s,
    unclean_shutdowns: raw.unclean_shutdowns,
    orphan_reaps: raw.orphan_reaps_registry + raw.orphan_reaps_legacy,
    orphan_reaps_after_unclean_exit: raw.orphan_reaps_after_unclean_exit,
    reveal_no_ops: raw.reveal_no_ops,
    brain_index_quarantined: raw.brain_index_quarantined
  }
}

/**
 * Applies soak-rule-1 to a parsed summary. `problems` lists why the summary is ineligible; when it is
 * empty, `verdict` is PROCEED or HOLD and `counts`, `run` describe the window.
 */
export function evaluateSoak(summary) {
  const problems = []
  if (!isPlainObject(summary)) return { problems: ['summary: expected a JSON object'] }
  if (summary.kind !== 'metis-diagnostics-summary') problems.push("kind: expected 'metis-diagnostics-summary'")
  if (summary.schema !== 2) problems.push('schema: expected 2')
  if (summary.app?.version !== SOAK_VERSION) problems.push(`app.version: expected ${SOAK_VERSION}`)
  const scope = summary.scope
  if (!isPlainObject(scope)) return { problems: [...problems, 'scope: expected an object'] }
  if (scope.version !== SOAK_VERSION) problems.push(`scope.version: expected ${SOAK_VERSION}`)
  if (summary.window?.truncated !== false) problems.push('window.truncated: the audit read must be complete')

  const counts = countsOf(scope.soak, problems)
  const days = isPlainObject(scope.days) ? scope.days : {}
  if (!isPlainObject(scope.days)) problems.push('scope.days: expected an object')
  const run = longestActiveRun(days)
  if (!run || run.length < MIN_CONSECUTIVE_DAYS) {
    problems.push(`scope.days: needs at least ${MIN_CONSECUTIVE_DAYS} consecutive active days, found ${run?.length ?? 0}`)
  }
  if (problems.length > 0) return { problems }
  return { problems, counts, run, verdict: verdictFor(counts) }
}

/** The MEASURED record content for the soak file: `key: value` lines, dates and counts only. */
export function soakRecordContent({ counts, run, verdict }) {
  return [
    '# Owner soak, five-day window',
    '',
    'evidence_level: MEASURED',
    `rule: ${SOAK_RULE_ID}`,
    `app_version: ${SOAK_VERSION}`,
    `consecutive_active_days: ${run.length}`,
    `first_day: ${run.first}`,
    `last_day: ${run.last}`,
    `stalls_over_5s: ${counts.stalls_over_5s}`,
    `unclean_shutdowns: ${counts.unclean_shutdowns}`,
    `orphan_reaps: ${counts.orphan_reaps}`,
    `orphan_reaps_after_unclean_exit: ${counts.orphan_reaps_after_unclean_exit}`,
    `reveal_no_ops: ${counts.reveal_no_ops}`,
    `brain_index_quarantined: ${counts.brain_index_quarantined}`,
    `verdict: ${verdict}`,
    '',
    'Content-free: UTC dates and counts only.',
    ''
  ].join('\n')
}

const RECORD_KEYS = Object.freeze([
  'evidence_level', 'rule', 'app_version', 'consecutive_active_days', 'first_day', 'last_day',
  ...COUNT_KEYS, 'orphan_reaps_after_unclean_exit', 'verdict'
])

/** Problems with a soak record's text: shape, privacy, and a verdict that the counts do not support. */
export function soakRecordProblems(text) {
  const problems = []
  if (USER_PATH_RE.test(text) || EMAIL_RE.test(text)) problems.push('record: must not contain a user path or an email address')
  const fields = new Map()
  for (const line of text.split(/\r?\n/)) {
    const match = /^([a-z][a-z0-9_]*): (.*)$/.exec(line)
    if (!match) continue
    if (fields.has(match[1])) problems.push(`record: ${match[1]} appears more than once`)
    fields.set(match[1], match[2])
  }
  for (const key of RECORD_KEYS) {
    if (!fields.has(key)) problems.push(`record: missing ${key}`)
  }
  if (problems.length > 0) return problems

  if (fields.get('evidence_level') !== 'MEASURED') problems.push('record: evidence_level must be MEASURED')
  if (fields.get('rule') !== SOAK_RULE_ID) problems.push(`record: rule must be ${SOAK_RULE_ID}`)
  if (fields.get('app_version') !== SOAK_VERSION) problems.push(`record: app_version must be ${SOAK_VERSION}`)

  const number = (key) => (/^\d+$/.test(fields.get(key)) ? Number(fields.get(key)) : NaN)
  for (const key of ['consecutive_active_days', ...COUNT_KEYS, 'orphan_reaps_after_unclean_exit']) {
    if (!isCount(number(key))) problems.push(`record: ${key} must be a non-negative integer`)
  }
  const first = fields.get('first_day')
  const last = fields.get('last_day')
  const dayCount = (Date.parse(last) - Date.parse(first)) / DAY_MS + 1
  if (!DAY_RE.test(first) || !DAY_RE.test(last) || !Number.isInteger(dayCount) || dayCount < 1) {
    problems.push('record: first_day and last_day must be UTC dates with first_day not after last_day')
  } else if (dayCount !== number('consecutive_active_days')) {
    problems.push('record: consecutive_active_days must equal the days from first_day to last_day')
  }
  if (number('consecutive_active_days') < MIN_CONSECUTIVE_DAYS) {
    problems.push(`record: consecutive_active_days must be at least ${MIN_CONSECUTIVE_DAYS}`)
  }
  if (number('orphan_reaps_after_unclean_exit') > number('orphan_reaps')) {
    problems.push('record: orphan_reaps_after_unclean_exit cannot exceed orphan_reaps')
  }
  if (!['PROCEED', 'HOLD'].includes(fields.get('verdict'))) {
    problems.push('record: verdict must be PROCEED or HOLD')
  } else if (problems.length === 0) {
    const counts = Object.fromEntries(COUNT_KEYS.map((key) => [key, number(key)]))
    if (fields.get('verdict') !== verdictFor(counts)) {
      problems.push(`record: verdict ${fields.get('verdict')} contradicts the counts under ${SOAK_RULE_ID}`)
    }
  }
  return problems
}

function compareVersion(a, b) {
  const left = String(a).split('.').map((part) => Number(part))
  const right = String(b).split('.').map((part) => Number(part))
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = Number.isInteger(left[i]) ? left[i] : 0
    const r = Number.isInteger(right[i]) ? right[i] : 0
    if (l !== r) return l - r
  }
  return 0
}

function p95Of(timings, key, problems) {
  const stat = timings?.[key]
  const value = stat?.p95
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    problems.push(`scope.history.notDownloaded.timings.${key}.p95: expected a non-negative number`)
    return null
  }
  return value
}

/**
 * Applies history-rule-1 to a parsed summary. The rule is only for T1 owner-channel History evidence:
 * version 1.9.9+, complete audit read, enough not-downloaded served requests, and p95s under limits.
 */
export function evaluateHistory(summary, { minNotDownloadedRequests = HISTORY_DEFAULT_MIN_NOT_DOWNLOADED_REQUESTS } = {}) {
  const problems = []
  if (!isCount(minNotDownloadedRequests) || minNotDownloadedRequests < HISTORY_DEFAULT_MIN_NOT_DOWNLOADED_REQUESTS) {
    return {
      problems: [
        `minNotDownloadedRequests: expected an integer at least ${HISTORY_DEFAULT_MIN_NOT_DOWNLOADED_REQUESTS}`
      ]
    }
  }
  if (!isPlainObject(summary)) return { problems: ['summary: expected a JSON object'] }
  if (summary.kind !== 'metis-diagnostics-summary') problems.push("kind: expected 'metis-diagnostics-summary'")
  if (summary.schema !== 2) problems.push('schema: expected 2')
  if (summary.window?.truncated !== false) problems.push('window.truncated: the audit read must be complete')

  const version = summary.app?.version
  if (typeof version !== 'string' || compareVersion(version, HISTORY_MIN_VERSION) < 0) {
    problems.push(`app.version: expected ${HISTORY_MIN_VERSION} or later`)
  }
  const scope = summary.scope
  if (!isPlainObject(scope)) return { problems: [...problems, 'scope: expected an object'] }
  if (scope.version !== version) problems.push('scope.version: expected the same version as app.version')
  const history = scope.history
  if (!isPlainObject(history)) return { problems: [...problems, 'scope.history: expected an object'] }
  if (history.status !== 'present') problems.push('scope.history: expected present History requests')
  if (!isCount(history.requests) || history.requests < 1) problems.push('scope.history.requests: expected a positive integer')

  const notDownloaded = history.notDownloaded
  if (!isPlainObject(notDownloaded)) return { problems: [...problems, 'scope.history.notDownloaded: expected an object'] }
  const served = notDownloaded.served
  if (!isCount(served)) problems.push('scope.history.notDownloaded.served: expected a non-negative integer')
  else if (served < minNotDownloadedRequests) {
    problems.push(`scope.history.notDownloaded.served: expected at least ${minNotDownloadedRequests}, found ${served}`)
  }

  const timings = notDownloaded.timings
  const p95 = {
    queue_ms: p95Of(timings, 'queueMs', problems),
    main_ms: p95Of(timings, 'mainMs', problems),
    ipc_ms: p95Of(timings, 'ipcMs', problems),
    render_ms: p95Of(timings, 'renderMs', problems),
    total_ms: p95Of(timings, 'totalMs', problems)
  }
  if (problems.length > 0) return { problems }
  const overLimit = Object.entries(HISTORY_P95_LIMITS_MS)
    .filter(([key, limit]) => p95[key] > limit)
    .map(([key]) => key)
  return {
    problems,
    version,
    minNotDownloadedRequests,
    notDownloadedServed: served,
    p95,
    verdict: overLimit.length === 0 ? 'PASS' : 'HOLD',
    overLimit
  }
}

export function historyRecordContent({ result, buildSha256 }) {
  return [
    '# Owner History timing window',
    '',
    'evidence_level: MEASURED',
    `rule: ${HISTORY_RULE_ID}`,
    `app_version: ${result.version}`,
    'environment_host: owner-mac',
    `build_sha256: ${buildSha256}`,
    'lead_action: file_m2_0067_record_from_artifact',
    `min_not_downloaded_requests: ${result.minNotDownloadedRequests}`,
    `not_downloaded_served_requests: ${result.notDownloadedServed}`,
    `queue_p95_ms: ${result.p95.queue_ms}`,
    `main_p95_ms: ${result.p95.main_ms}`,
    `ipc_p95_ms: ${result.p95.ipc_ms}`,
    `render_p95_ms: ${result.p95.render_ms}`,
    `total_p95_ms: ${result.p95.total_ms}`,
    `queue_p95_limit_ms: ${HISTORY_P95_LIMITS_MS.queue_ms}`,
    `main_p95_limit_ms: ${HISTORY_P95_LIMITS_MS.main_ms}`,
    `ipc_p95_limit_ms: ${HISTORY_P95_LIMITS_MS.ipc_ms}`,
    `render_p95_limit_ms: ${HISTORY_P95_LIMITS_MS.render_ms}`,
    `total_p95_limit_ms: ${HISTORY_P95_LIMITS_MS.total_ms}`,
    `verdict: ${result.verdict}`,
    '',
    'Content-free: aggregate timings and counts only.',
    ''
  ].join('\n')
}

export function historyRecordProblems(text) {
  const problems = []
  if (USER_PATH_RE.test(text) || EMAIL_RE.test(text)) problems.push('record: must not contain a user path or an email address')
  const fields = new Map()
  for (const line of text.split(/\r?\n/)) {
    const match = /^([a-z][a-z0-9_]*): (.*)$/.exec(line)
    if (!match) continue
    if (fields.has(match[1])) problems.push(`record: ${match[1]} appears more than once`)
    fields.set(match[1], match[2])
  }
  const keys = [
    'evidence_level', 'rule', 'app_version', 'environment_host', 'build_sha256',
    'lead_action',
    'min_not_downloaded_requests', 'not_downloaded_served_requests',
    'queue_p95_ms', 'main_p95_ms', 'ipc_p95_ms', 'render_p95_ms', 'total_p95_ms',
    'queue_p95_limit_ms', 'main_p95_limit_ms', 'ipc_p95_limit_ms', 'render_p95_limit_ms', 'total_p95_limit_ms',
    'verdict'
  ]
  for (const key of keys) {
    if (!fields.has(key)) problems.push(`record: missing ${key}`)
  }
  if (problems.length > 0) return problems
  if (fields.get('evidence_level') !== 'MEASURED') problems.push('record: evidence_level must be MEASURED')
  if (fields.get('rule') !== HISTORY_RULE_ID) problems.push(`record: rule must be ${HISTORY_RULE_ID}`)
  if (fields.get('environment_host') !== 'owner-mac') problems.push('record: environment_host must be owner-mac')
  if (!SHA256_RE.test(fields.get('build_sha256'))) problems.push('record: build_sha256 must be a sha256 hex digest')
  if (fields.get('lead_action') !== 'file_m2_0067_record_from_artifact') {
    problems.push('record: lead_action must be file_m2_0067_record_from_artifact')
  }
  const number = (key) => (/^\d+(?:\.\d+)?$/.test(fields.get(key)) ? Number(fields.get(key)) : NaN)
  for (const key of keys.filter((key) => key.endsWith('_ms') || key.endsWith('_requests'))) {
    if (!Number.isFinite(number(key)) || number(key) < 0) problems.push(`record: ${key} must be a non-negative number`)
  }
  if (!['PASS', 'HOLD'].includes(fields.get('verdict'))) problems.push('record: verdict must be PASS or HOLD')
  return problems
}

function usageExit(message) {
  console.error(message)
  process.exit(2)
}

function main() {
  const { values } = parseArgs({
    options: {
      summary: { type: 'string' },
      out: { type: 'string' },
      mode: { type: 'string', default: 'soak' },
      'build-sha256': { type: 'string' },
      'min-history-requests': { type: 'string' }
    }
  })
  if (typeof values.summary !== 'string') return usageExit('usage: verdict.mjs --summary <summary.json> [--out <dir>]')
  let summary
  try {
    summary = JSON.parse(readFileSync(resolve(values.summary), 'utf8'))
  } catch (error) {
    return usageExit(`could not read the summary: ${error.message}`)
  }
  if (values.mode === 'history') {
    if (typeof values['build-sha256'] !== 'string' || !SHA256_RE.test(values['build-sha256'])) {
      return usageExit('history mode requires --build-sha256 <64-hex-sha256>')
    }
    const min = values['min-history-requests'] === undefined
      ? HISTORY_DEFAULT_MIN_NOT_DOWNLOADED_REQUESTS
      : Number(values['min-history-requests'])
    const result = evaluateHistory(summary, { minNotDownloadedRequests: min })
    if (result.problems.length > 0) {
      for (const problem of result.problems) console.error(`- ${problem}`)
      process.exit(1)
    }
    const outDir = resolve(values.out ?? DEFAULT_OUT_DIR)
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, HISTORY_RECORD_FILE), historyRecordContent({ result, buildSha256: values['build-sha256'].toLowerCase() }))
    console.log(`owner history: ${result.verdict} (${result.notDownloadedServed} not-downloaded served requests)`)
    return
  }
  if (values.mode !== 'soak') return usageExit('mode must be soak or history')
  const result = evaluateSoak(summary)
  if (result.problems.length > 0) {
    for (const problem of result.problems) console.error(`- ${problem}`)
    process.exit(1)
  }
  const outDir = resolve(values.out ?? DEFAULT_OUT_DIR)
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, RECORD_FILE), soakRecordContent(result))
  console.log(`owner soak: ${result.verdict} (${result.run.length} consecutive active days)`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
