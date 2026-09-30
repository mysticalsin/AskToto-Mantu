#!/usr/bin/env node
// Owner-bug closure evaluator (M2-0199): the closure mode that follows the M2-0198 five-day soak.
//
// Turns the schema-2 diagnostics summary the owner pastes after the closure window (plus, on a violation,
// the folder Export diagnostics bundle wrote) into a content-free MEASURED closure record, the interim bug
// wording, a lead handoff and, on a violation, a release/1.9.x hotfix-ticket stub. Under D-28 this runs
// only in GitHub Actions (.github/workflows/owner-closure.yml).
//
// PRE-REGISTERED RULE closure-rule-1 (written before any real data; changing it means a new rule id):
//   Eligible : kind 'metis-diagnostics-summary', schema 2, app.version equal to scope.version, an
//              owner-channel version (1.9.7, a 1.9.7-hotfix.N, or a later X.Y.Z other than the retired
//              1.9.8; never a beta or rc), and an audit read that was not truncated.
//   Working day: a UTC day in scope.days that falls Monday to Friday and carries at least one record.
//   REOPEN   : any of stallsOver5s, orphanReaps.afterUncleanExit or revealNoOps above zero, whatever the
//              window length. B1 (the freeze) reopens on a stall over 5 s or a reveal no-op; B2 (the
//              heaviness) reopens on an owned sidecar reaped after an unclean exit.
//   CLOSE    : no violation over at least MIN_WORKING_DAYS working days. CLOSE is MEASURED only; a bug is
//              'fixed' once the owner also accepts it in writing (an ACCEPTED owner-acceptance.md).
//   PENDING  : no violation yet, fewer than MIN_WORKING_DAYS working days: keep the build and soak on.
//   Until a bug is fixed it carries its interim wording (INTERIM_STATUS), never 'fixed'.
// Every file written holds UTC dates, counts, versions and stall-bundle file names only.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { MAX_STALL_BUNDLE_FILE_BYTES, STALL_BUNDLE_NAME, isStallBundle } from '../freeze-repro/attribution-bundle.mjs'
import { PROMOTED_BASE, RETIRED_VERSION } from '../release-line.mjs'

export const CLOSURE_RULE_ID = 'closure-rule-1'
export const MIN_WORKING_DAYS = 10
export const DEFAULT_OUT_DIR = 'out/owner-closure'
export const HOTFIX_BRANCH = 'release/1.9.x'
export const FILES = Object.freeze({
  record: 'closure-record.md',
  status: 'bug-status.md',
  leadAction: 'M2-0199.lead-action.md',
  hotfixStub: 'hotfix-ticket-stub.md',
  acceptance: 'owner-acceptance.md',
  stalls: 'stalls'
})
export const BUGS = Object.freeze(['B1', 'B2'])
/** The only wording a bug may carry before the MEASURED CLOSE record and the owner's written acceptance. */
export const INTERIM_STATUS = Object.freeze({
  B1: 'fixed for the DERIVED cause',
  B2: 'fixed for the CONFIRMED orphan mechanism'
})
export const VERDICTS = Object.freeze(['CLOSE', 'PENDING', 'REOPEN'])

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const NUMBER = '(?:0|[1-9]\\d*)'
const STABLE_VERSION = new RegExp(`^(${NUMBER})\\.(${NUMBER})\\.(${NUMBER})$`)
const HOTFIX_VERSION = new RegExp(`^${PROMOTED_BASE.replace(/\./g, '\\.')}-hotfix\\.[1-9]\\d*$`)
const AUDIT_LOG_NAME = /^audit(-\d+)?\.log$/
const USER_PATH_RE = /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^\s/\\]+/i
const EMAIL_RE = /[^\s@<>]+@[^\s@<>]+\.[A-Za-z]{2,}/

const isCount = (value) => Number.isInteger(value) && value >= 0
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** 1.9.7, a 1.9.7-hotfix.N, or a stable X.Y.Z after 1.9.7 other than the retired 1.9.8. */
export function isOwnerChannelVersion(version) {
  if (typeof version !== 'string') return false
  if (HOTFIX_VERSION.test(version)) return true
  const match = STABLE_VERSION.exec(version)
  if (!match || version === RETIRED_VERSION) return false
  const [major, minor, patch] = match.slice(1).map(Number)
  const [baseMajor, baseMinor, basePatch] = PROMOTED_BASE.split('.').map(Number)
  return major !== baseMajor ? major > baseMajor : minor !== baseMinor ? minor > baseMinor : patch >= basePatch
}

/** Active Monday-to-Friday UTC days among `scope.days`, oldest first. */
export function workingDays(days) {
  return Object.keys(days)
    .filter((key) => DAY_RE.test(key) && !Number.isNaN(Date.parse(key)) && days[key]?.records > 0)
    .filter((key) => {
      const weekday = new Date(`${key}T00:00:00Z`).getUTCDay()
      return weekday >= 1 && weekday <= 5
    })
    .sort()
}

/** The bugs a set of counts reopens, in BUGS order. */
export function reopenedBugs(counts) {
  const bugs = []
  if (counts.stalls_over_5s > 0 || counts.reveal_no_ops > 0) bugs.push('B1')
  if (counts.orphan_reaps_after_unclean_exit > 0) bugs.push('B2')
  return bugs
}

export function verdictFor(counts, workingDayCount) {
  if (reopenedBugs(counts).length > 0) return 'REOPEN'
  return workingDayCount >= MIN_WORKING_DAYS ? 'CLOSE' : 'PENDING'
}

/**
 * The summary counts every in-scope stall over 5 s and reveal no-op in scope.soak, and in its day bucket
 * only when the record carries a timestamp, so each soak total is at least the sum of its per-day counts.
 * A summary that breaks this cannot be trusted to show zero violations.
 */
function dayTotalProblems(days, soak) {
  const problems = []
  for (const field of ['stallsOver5s', 'revealNoOps']) {
    let sum = 0
    for (const [key, day] of Object.entries(days)) {
      const value = day?.[field] ?? 0
      if (!isCount(value)) problems.push(`scope.days.${key}.${field}: must be a non-negative integer`)
      else sum += value
    }
    if (isCount(soak?.[field]) && sum > soak[field]) {
      problems.push(`scope.days: ${field} per day sum to ${sum}, more than scope.soak.${field} (${soak[field]})`)
    }
  }
  return problems
}

/**
 * Applies closure-rule-1 to a parsed summary. `problems` lists why the summary is ineligible; when it is
 * empty the result carries the version, counts, working days and verdict.
 */
export function evaluateClosure(summary) {
  if (!isPlainObject(summary)) return { problems: ['summary: expected a JSON object'] }
  const problems = []
  if (summary.kind !== 'metis-diagnostics-summary') problems.push("kind: expected 'metis-diagnostics-summary'")
  if (summary.schema !== 2) problems.push('schema: expected 2')
  const scope = summary.scope
  if (!isPlainObject(scope)) return { problems: [...problems, 'scope: expected an object'] }
  const version = summary.app?.version
  if (!isOwnerChannelVersion(version)) {
    problems.push(`app.version: expected ${PROMOTED_BASE}, a ${PROMOTED_BASE}-hotfix.N or a later owner-channel release`)
  }
  if (scope.version !== version) problems.push('scope.version: must equal app.version')
  if (summary.window?.truncated !== false) problems.push('window.truncated: the audit read must be complete')

  const soak = scope.soak
  const counts = {
    stalls_over_5s: soak?.stallsOver5s,
    orphan_reaps_after_unclean_exit: soak?.orphanReaps?.afterUncleanExit,
    reveal_no_ops: soak?.revealNoOps
  }
  for (const [key, value] of Object.entries(counts)) {
    if (!isCount(value)) problems.push(`scope.soak: ${key} must be a non-negative integer`)
  }
  if (!isPlainObject(scope.days)) problems.push('scope.days: expected an object')
  else problems.push(...dayTotalProblems(scope.days, soak))
  if (problems.length > 0) return { problems }

  const days = workingDays(scope.days)
  return {
    problems,
    version,
    scope: { from: scope.from ?? null, to: scope.to ?? null },
    counts,
    days,
    reopens: reopenedBugs(counts),
    verdict: verdictFor(counts, days.length)
  }
}

/** A regular file (never a symlink) no larger than a bundle, whose content is a collector bundle. */
function isAttachableBundle(exportDir, name) {
  try {
    const path = join(exportDir, name)
    const info = lstatSync(path)
    if (!info.isFile() || info.size > MAX_STALL_BUNDLE_FILE_BYTES) return false
    return isStallBundle(name, readFileSync(path, 'utf8'))
  } catch {
    return false
  }
}

/**
 * Stall-bundle file names the sampler audited (app.stall.sampled) inside the closure scope, that the
 * exported diagnostics folder also carries as a redacted collector bundle (isStallBundle). A bundle-named
 * file with any other content, a symlink or a directory is never returned, so it never reaches the artifact.
 */
export function attachedSamplerBundles(exportDir, scope) {
  const files = new Set(readdirSync(exportDir))
  const names = new Set()
  for (const log of [...files].filter((name) => AUDIT_LOG_NAME.test(name)).sort()) {
    for (const line of readFileSync(join(exportDir, log), 'utf8').split(/\r?\n/)) {
      let row
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      if (row?.event !== 'app.stall.sampled' || typeof row.bundle !== 'string' || !STALL_BUNDLE_NAME.test(row.bundle)) continue
      if (typeof row.ts !== 'string' || (scope.from && row.ts < scope.from) || (scope.to && row.ts > scope.to)) continue
      if (files.has(row.bundle) && isAttachableBundle(exportDir, row.bundle)) names.add(row.bundle)
    }
  }
  return [...names].sort()
}

function field(value) {
  return Array.isArray(value) ? (value.length > 0 ? value.join(', ') : 'none') : String(value)
}

/** The MEASURED closure record: `key: value` lines, UTC dates, counts and bundle names only. */
export function closureRecordContent(result, { diagnosticsExport, samplerBundles }) {
  return [
    '# Owner-bug closure (M2-0199)',
    '',
    'evidence_level: MEASURED',
    `rule: ${CLOSURE_RULE_ID}`,
    `app_version: ${result.version}`,
    `working_days: ${result.days.length}`,
    `first_working_day: ${result.days[0] ?? 'none'}`,
    `last_working_day: ${result.days.at(-1) ?? 'none'}`,
    `stalls_over_5s: ${result.counts.stalls_over_5s}`,
    `orphan_reaps_after_unclean_exit: ${result.counts.orphan_reaps_after_unclean_exit}`,
    `reveal_no_ops: ${result.counts.reveal_no_ops}`,
    `verdict: ${result.verdict}`,
    `reopens: ${field(result.reopens)}`,
    `diagnostics_export: ${diagnosticsExport}`,
    `sampler_bundles: ${field(samplerBundles)}`,
    '',
    'Content-free: UTC dates, counts, versions and stall-bundle file names only.',
    ''
  ].join('\n')
}

/** Bug status as the tool computes it: reopened on a violation, otherwise the interim wording. */
export function bugStatusContent(reopens) {
  return [
    '# Owner bugs, status (M2-0199)',
    '',
    ...BUGS.map((bug) => `${bug.toLowerCase()}_status: ${reopens.includes(bug) ? 'reopened' : INTERIM_STATUS[bug]}`),
    '',
    `A bug may say 'fixed' only beside a MEASURED CLOSE ${FILES.record} and an ACCEPTED ${FILES.acceptance}`,
    `whose closure_record_sha256 is that record's sha256 (checked by scripts/evidence/check.mjs --ticket M2-0199).`,
    ''
  ].join('\n')
}

export function hotfixStubContent(result, samplerBundles) {
  return [
    `# Hotfix ticket stub: reopen ${result.reopens.join(' and ')} (from M2-0199)`,
    '',
    `branch: ${HOTFIX_BRANCH}`,
    `version_rule: ${PROMOTED_BASE}-hotfix.N (M2-0499)`,
    `reopens: ${result.reopens.join(', ')}`,
    `app_version: ${result.version}`,
    `stalls_over_5s: ${result.counts.stalls_over_5s}`,
    `orphan_reaps_after_unclean_exit: ${result.counts.orphan_reaps_after_unclean_exit}`,
    `reveal_no_ops: ${result.counts.reveal_no_ops}`,
    `sampler_bundles: ${field(samplerBundles)}`,
    '',
    `LEAD_ACTION: open a fix ticket on ${HOTFIX_BRANCH} for ${result.reopens.join(' and ')}, attach this closure`,
    `artifact (${FILES.record} and ${FILES.stalls}/), reproduce the violation with a failing test first, and ship`,
    `it as the next ${PROMOTED_BASE}-hotfix.N. The M2-0199 closure window restarts on that build.`,
    ''
  ].join('\n')
}

export function leadActionContent(result, recordSha256) {
  const lines = ['# M2-0199 lead action', '']
  if (result.verdict === 'CLOSE') {
    lines.push(
      `LEAD_ACTION: file the M2-0199 MEASURED record from ${FILES.record} (sha256 ${recordSha256}).`,
      'Then ask the owner to accept or reject the closure in writing, and file the answer beside it as',
      `${FILES.acceptance} with these lines:`,
      '',
      'evidence_level: ACCEPTED',
      'ticket: M2-0199',
      'decision: accept',
      'accepted_on: YYYY-MM-DD',
      `closure_record_sha256: ${recordSha256}`,
      '',
      `Only after an accept may ${FILES.status} say 'fixed'. Until then B1 stays '${INTERIM_STATUS.B1}'`,
      `and B2 stays '${INTERIM_STATUS.B2}'.`
    )
  } else if (result.verdict === 'PENDING') {
    lines.push(
      `LEAD_ACTION: no violation yet, ${result.days.length} of ${MIN_WORKING_DAYS} working days. Keep the owner-channel`,
      'build as the daily build and paste a fresh summary later. The bugs keep their interim wording.'
    )
  } else {
    lines.push(
      `LEAD_ACTION: reopen ${result.reopens.join(' and ')} with this artifact attached and open the hotfix ticket`,
      `from ${FILES.hotfixStub} on ${HOTFIX_BRANCH}. A reopen needs the owner's exported diagnostics bundle`,
      '(tray > Export diagnostics bundle, passed with --export) so the sampler bundles travel with it.'
    )
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * Evaluate, then write the closure directory. Returns the result; nothing is written when ineligible.
 * @param {{summary: unknown, exportDir?: string, out: string}} args
 */
export function writeClosure({ summary, exportDir, out }) {
  const result = evaluateClosure(summary)
  if (result.problems.length > 0) return result
  mkdirSync(out, { recursive: true })
  const samplerBundles = exportDir ? attachedSamplerBundles(exportDir, result.scope) : []
  if (samplerBundles.length > 0) {
    mkdirSync(join(out, FILES.stalls), { recursive: true })
    for (const name of samplerBundles) copyFileSync(join(exportDir, name), join(out, FILES.stalls, name))
  }
  const diagnosticsExport = exportDir ? 'attached' : result.verdict === 'REOPEN' ? 'missing' : 'not-needed'
  const record = closureRecordContent(result, { diagnosticsExport, samplerBundles })
  writeFileSync(join(out, FILES.record), record)
  writeFileSync(join(out, FILES.status), bugStatusContent(result.reopens))
  writeFileSync(join(out, FILES.leadAction), leadActionContent(result, sha256Hex(record)))
  if (result.verdict === 'REOPEN') writeFileSync(join(out, FILES.hotfixStub), hotfixStubContent(result, samplerBundles))
  return result
}

/** `key: value` lines of a record file; a repeated key is a problem. */
function parseFields(text, label, problems) {
  if (USER_PATH_RE.test(text) || EMAIL_RE.test(text)) problems.push(`${label}: must not contain a user path or an email address`)
  const fields = new Map()
  for (const line of text.split(/\r?\n/)) {
    const match = /^([a-z][a-z0-9_]*): (.*)$/.exec(line)
    if (!match) continue
    if (fields.has(match[1])) problems.push(`${label}: ${match[1]} appears more than once`)
    fields.set(match[1], match[2].trim())
  }
  return fields
}

const listField = (value) => (value === 'none' ? [] : value.split(',').map((item) => item.trim()))
const RECORD_KEYS = Object.freeze([
  'evidence_level', 'rule', 'app_version', 'working_days', 'first_working_day', 'last_working_day', 'stalls_over_5s',
  'orphan_reaps_after_unclean_exit', 'reveal_no_ops', 'verdict', 'reopens', 'diagnostics_export', 'sampler_bundles'
])

function recordProblems(root, text) {
  const problems = []
  const fields = parseFields(text, FILES.record, problems)
  for (const key of RECORD_KEYS) {
    if (!fields.has(key)) problems.push(`${FILES.record}: missing ${key}`)
  }
  if (problems.length > 0) return { problems, fields }

  if (fields.get('evidence_level') !== 'MEASURED') problems.push(`${FILES.record}: evidence_level must be MEASURED`)
  if (fields.get('rule') !== CLOSURE_RULE_ID) problems.push(`${FILES.record}: rule must be ${CLOSURE_RULE_ID}`)
  if (!isOwnerChannelVersion(fields.get('app_version'))) problems.push(`${FILES.record}: app_version must be an owner-channel version`)
  const number = (key) => (/^\d+$/.test(fields.get(key)) ? Number(fields.get(key)) : NaN)
  const counts = {}
  for (const key of ['working_days', 'stalls_over_5s', 'orphan_reaps_after_unclean_exit', 'reveal_no_ops']) {
    counts[key] = number(key)
    if (!isCount(counts[key])) problems.push(`${FILES.record}: ${key} must be a non-negative integer`)
  }
  const first = fields.get('first_working_day')
  const last = fields.get('last_working_day')
  const noDays = counts.working_days === 0 && first === 'none' && last === 'none'
  if (!noDays && !(DAY_RE.test(first) && DAY_RE.test(last) && first <= last)) {
    problems.push(`${FILES.record}: first_working_day and last_working_day must be UTC dates in order`)
  }
  const verdict = fields.get('verdict')
  if (!VERDICTS.includes(verdict)) {
    problems.push(`${FILES.record}: verdict must be one of ${VERDICTS.join(', ')}`)
  } else if (problems.length === 0) {
    if (verdict !== verdictFor(counts, counts.working_days)) {
      problems.push(`${FILES.record}: verdict ${verdict} contradicts the counts under ${CLOSURE_RULE_ID}`)
    }
    if (field(reopenedBugs(counts)) !== fields.get('reopens')) {
      problems.push(`${FILES.record}: reopens must name exactly the bugs the counts reopen`)
    }
  }
  if (!['attached', 'missing', 'not-needed'].includes(fields.get('diagnostics_export'))) {
    problems.push(`${FILES.record}: diagnostics_export must be attached, missing or not-needed`)
  }
  if (verdict === 'REOPEN') {
    if (fields.get('diagnostics_export') !== 'attached') {
      problems.push(`${FILES.record}: a REOPEN needs the owner's exported diagnostics bundle attached (--export)`)
    }
    const stub = join(root, FILES.hotfixStub)
    if (!existsSync(stub)) problems.push(`${FILES.hotfixStub}: a REOPEN needs the hotfix-ticket stub`)
    else if (!readFileSync(stub, 'utf8').includes(`branch: ${HOTFIX_BRANCH}`)) {
      problems.push(`${FILES.hotfixStub}: must target ${HOTFIX_BRANCH}`)
    }
  }
  for (const name of listField(fields.get('sampler_bundles'))) {
    if (!STALL_BUNDLE_NAME.test(name)) problems.push(`${FILES.record}: sampler_bundles must hold stall-bundle file names only`)
    else if (!existsSync(join(root, FILES.stalls, name))) problems.push(`${FILES.stalls}/${name}: named by the record but not attached`)
    else if (!isAttachableBundle(join(root, FILES.stalls), name)) problems.push(`${FILES.stalls}/${name}: is not a redacted collector bundle`)
  }
  return { problems, fields }
}

function acceptanceProblems(text, recordSha256, verdict) {
  const problems = []
  const fields = parseFields(text, FILES.acceptance, problems)
  if (fields.get('evidence_level') !== 'ACCEPTED') problems.push(`${FILES.acceptance}: evidence_level must be ACCEPTED`)
  if (fields.get('ticket') !== 'M2-0199') problems.push(`${FILES.acceptance}: ticket must be M2-0199`)
  if (!['accept', 'reject'].includes(fields.get('decision'))) problems.push(`${FILES.acceptance}: decision must be accept or reject`)
  if (!DAY_RE.test(fields.get('accepted_on') ?? '')) problems.push(`${FILES.acceptance}: accepted_on must be a UTC date`)
  const sha = fields.get('closure_record_sha256') ?? ''
  if (!SHA256_RE.test(sha)) problems.push(`${FILES.acceptance}: closure_record_sha256 must be a lowercase sha256`)
  else if (sha !== recordSha256) problems.push(`${FILES.acceptance}: closure_record_sha256 does not match ${FILES.record}`)
  if (fields.get('decision') === 'accept' && verdict !== 'CLOSE') {
    problems.push(`${FILES.acceptance}: the owner can accept only a CLOSE verdict`)
  }
  return { problems, accepted: problems.length === 0 && fields.get('decision') === 'accept' }
}

/**
 * The M2-0199 validator: the closure directory's record is well formed and its verdict follows from its
 * counts, a violation carries its reopen, and no bug says 'fixed' without the MEASURED CLOSE record and
 * the owner's matching ACCEPTED record. Every other status must be the interim wording or 'reopened'.
 */
export function closureDirProblems(dirPath) {
  const root = resolve(dirPath)
  const problems = []
  for (const file of [FILES.record, FILES.status, FILES.leadAction]) {
    if (!existsSync(join(root, file))) problems.push(`${file}: missing from the M2-0199 closure directory`)
  }
  if (problems.length > 0) return problems

  const recordBytes = readFileSync(join(root, FILES.record))
  const record = recordProblems(root, recordBytes.toString('utf8'))
  problems.push(...record.problems)
  const verdict = record.fields.get('verdict')
  const reopens = listField(record.fields.get('reopens') ?? 'none')

  const leadAction = readFileSync(join(root, FILES.leadAction), 'utf8')
  if (!leadAction.includes('LEAD_ACTION:') || !leadAction.includes('M2-0199')) {
    problems.push(`${FILES.leadAction}: must hand off a LEAD_ACTION naming M2-0199`)
  }

  let accepted = false
  const acceptancePath = join(root, FILES.acceptance)
  if (existsSync(acceptancePath)) {
    const acceptance = acceptanceProblems(readFileSync(acceptancePath, 'utf8'), sha256Hex(recordBytes), verdict)
    problems.push(...acceptance.problems)
    accepted = acceptance.accepted && record.problems.length === 0
  }

  const statusFields = parseFields(readFileSync(join(root, FILES.status), 'utf8'), FILES.status, problems)
  for (const bug of BUGS) {
    const key = `${bug.toLowerCase()}_status`
    const status = statusFields.get(key)
    if (status === undefined) {
      problems.push(`${FILES.status}: missing ${key}`)
    } else if (reopens.includes(bug)) {
      if (status !== 'reopened') problems.push(`${FILES.status}: ${bug} must be 'reopened' after a violation`)
    } else if (status === 'fixed') {
      if (!(verdict === 'CLOSE' && accepted)) {
        problems.push(`${FILES.status}: ${bug} may not say 'fixed' without the MEASURED CLOSE record and the owner's ACCEPTED record`)
      }
    } else if (status !== INTERIM_STATUS[bug]) {
      problems.push(`${FILES.status}: ${bug} must read '${INTERIM_STATUS[bug]}' until it is accepted as fixed`)
    }
  }
  return problems
}

function usageExit(message) {
  console.error(message)
  process.exit(2)
}

function main() {
  const { values } = parseArgs({ options: { summary: { type: 'string' }, export: { type: 'string' }, out: { type: 'string' } } })
  if (typeof values.summary !== 'string') {
    return usageExit('usage: closure.mjs --summary <summary.json> [--export <exported diagnostics folder>] [--out <dir>]')
  }
  let summary
  try {
    summary = JSON.parse(readFileSync(resolve(values.summary), 'utf8'))
  } catch (error) {
    return usageExit(`could not read the summary: ${error.message}`)
  }
  const exportDir = values.export ? resolve(values.export) : undefined
  if (exportDir && !existsSync(exportDir)) return usageExit('the --export folder does not exist')
  const result = writeClosure({ summary, exportDir, out: resolve(values.out ?? DEFAULT_OUT_DIR) })
  if (result.problems.length > 0) {
    for (const problem of result.problems) console.error(`- ${problem}`)
    process.exit(1)
  }
  console.log(`owner closure: ${result.verdict} (${result.days.length} working days${result.reopens.length ? `, reopens ${result.reopens.join(', ')}` : ''})`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
