import * as fs from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export const MAX_REPORT_BYTES = 64 * 1024 * 1024
const MAX_FILES = 10_000
const MAX_ASSERTIONS = 100_000
const MAX_SKIPS = 512
const MAX_OUTPUT_BYTES = 512 * 1024
const COUNT_KEYS = [
  'numTotalTestSuites', 'numPassedTestSuites', 'numFailedTestSuites', 'numPendingTestSuites',
  'numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests', 'numTodoTests'
]
const STATUSES = new Set(['passed', 'failed', 'pending', 'skipped', 'todo'])
const OUTCOMES = new Set(['success', 'failure', 'cancelled', 'skipped', 'not_run'])
const SCHEMA = 'metis-root-report-diagnostic/v1'
const AUTHORITY = 'UNATTESTED_DIAGNOSTIC_ONLY'
/** @typedef {{file: string, identitySha256: string, status: string, occurrence: number}} SkipIdentity */
/** @typedef {{exitCode: number, summary: {schema: string, authority: string, status: string, reasons?: string[], pipelineOutcome?: string, auditOutcome?: string, counts?: Record<string, number>, observed?: {files: number, assertions: number, skipped: number, todo: number}, skips?: SkipIdentity[], inventorySha256?: string}}} DiagnosticResult */
/** @typedef {{ci: string, githubActions: string, runnerTemp: string, workspace: string, reportPath: string, runId: string, runAttempt: string, matrixOs: string, pipelineOutcome: string, auditOutcome: string}} DiagnosticContext */
/** @typedef {{lstatSync: (path: string) => import('node:fs').Stats, realpathSync: (path: string) => string, openSync: (path: string, flags: number) => number, fstatSync: (fd: number) => import('node:fs').Stats, readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: null) => number, closeSync: (fd: number) => void}} DiagnosticIO */
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const digest = (value) => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
/** @returns {DiagnosticResult} */
const refuse = (status) => ({ exitCode: 1, summary: { schema: SCHEMA, authority: AUTHORITY, status } })

function stable(left, right) {
  return right.isFile?.() === true && ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every((key) => left[key] === right[key])
}

function outcome(value) {
  return value === '' ? 'not_run' : value
}

// The fixed workflow inputs name one direct runner-temp child for this exact matrix attempt.
function trustedContext(context, io) {
  if (!record(context) || context.ci !== 'true' || context.githubActions !== 'true' ||
      typeof context.runId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(context.runId) ||
      typeof context.runAttempt !== 'string' || !/^[1-9][0-9]{0,9}$/.test(context.runAttempt) ||
      !['ubuntu-latest', 'windows-latest'].includes(context.matrixOs) ||
      !OUTCOMES.has(outcome(context.pipelineOutcome)) || !OUTCOMES.has(outcome(context.auditOutcome))) return null
  for (const key of ['runnerTemp', 'workspace', 'reportPath']) {
    if (typeof context[key] !== 'string' || context[key].length > 8192 || /[\x00-\x1f\x7f]/.test(context[key]) ||
        !isAbsolute(context[key]) || context[key].split(/[\\/]/).some((part) => part === '.' || part === '..')) return null
  }
  const expected = `metis-ci-root-report-${context.runId}-${context.runAttempt}-${context.matrixOs}.json`
  if (basename(context.reportPath) !== expected || resolve(dirname(context.reportPath)) !== resolve(context.runnerTemp)) return false
  const runnerTemp = io.realpathSync(context.runnerTemp)
  const workspace = io.realpathSync(context.workspace)
  if (!io.lstatSync(runnerTemp).isDirectory() || !io.lstatSync(workspace).isDirectory()) return null
  return { runnerTemp, workspace, reportPath: join(runnerTemp, expected) }
}

// Only source-bound test filenames can be displayed; assertion identity strings are hashed only.
function sourceFile(name, workspace, io) {
  if (typeof name !== 'string' || name.length > 8192 || /[\x00-\x1f\x7f]/.test(name) || !isAbsolute(name) ||
      name.split(/[\\/]/).includes('..')) return null
  const file = relative(workspace, resolve(name)).split(sep).join('/')
  if (file.length > 512 || !/^(src\/|intelligence\/src\/|scripts\/|eval\/)/.test(file) ||
      !/\.(test|spec)\.tsx?$/.test(file) ||
      file.split('/').some((part) => !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part) || part === '..')) return null
  let path = workspace
  try {
    const parts = file.split('/')
    for (let index = 0; index < parts.length; index++) {
      path = join(path, parts[index])
      const stat = io.lstatSync(path)
      if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) return null
    }
    if (io.realpathSync(path) !== path) return null
  } catch { return null }
  return file
}

function summarize(report, context, workspace, io) {
  if (!record(report) || typeof report.success !== 'boolean') return refuse('NOT_PASS_SCHEMA')
  for (const key of COUNT_KEYS) {
    if (!Number.isSafeInteger(report[key]) || report[key] < 0) return refuse('NOT_PASS_SCHEMA')
    if (report[key] > MAX_ASSERTIONS) return refuse('NOT_PASS_LIMIT')
  }
  if (!Array.isArray(report.testResults) || report.testResults.length === 0 || report.numTotalTests === 0 ||
      report.numTotalTestSuites === 0) return refuse('NOT_PASS_INCOMPLETE')
  if (report.testResults.length > MAX_FILES) return refuse('NOT_PASS_LIMIT')
  if (report.numPassedTestSuites + report.numFailedTestSuites + report.numPendingTestSuites !== report.numTotalTestSuites) {
    return refuse('NOT_PASS_SCHEMA')
  }
  const counts = { passed: 0, failed: 0, pending: 0, skipped: 0, todo: 0 }
  const files = new Set()
  const skips = []
  let assertions = 0
  let failedFile = false
  for (const file of report.testResults) {
    if (!record(file) || !['passed', 'failed'].includes(file.status) || !Array.isArray(file.assertionResults)) {
      return refuse('NOT_PASS_SCHEMA')
    }
    const name = sourceFile(file.name, workspace, io)
    if (name === null || files.has(name.toLowerCase())) return refuse('NOT_PASS_IDENTITY')
    files.add(name.toLowerCase())
    failedFile ||= file.status === 'failed'
    for (const assertion of file.assertionResults) {
      if (!record(assertion) || !STATUSES.has(assertion.status)) return refuse('NOT_PASS_SCHEMA')
      if (++assertions > MAX_ASSERTIONS) return refuse('NOT_PASS_LIMIT')
      counts[assertion.status] += 1
      if (assertion.status !== 'pending' && assertion.status !== 'skipped') continue
      if (skips.length === MAX_SKIPS) return refuse('NOT_PASS_LIMIT')
      if (typeof assertion.title !== 'string' || Buffer.byteLength(assertion.title, 'utf8') > 4096 ||
          typeof assertion.fullName !== 'string' || Buffer.byteLength(assertion.fullName, 'utf8') > 16_384 ||
          !Array.isArray(assertion.ancestorTitles) || assertion.ancestorTitles.length > 64 ||
          assertion.ancestorTitles.some((title) => typeof title !== 'string' || Buffer.byteLength(title, 'utf8') > 4096)) {
        return refuse('NOT_PASS_IDENTITY')
      }
      skips.push({ file: name, identitySha256: digest([name, assertion.ancestorTitles, assertion.title, assertion.fullName]), status: assertion.status, occurrence: 0 })
    }
  }
  if (assertions !== report.numTotalTests || counts.passed !== report.numPassedTests || counts.failed !== report.numFailedTests ||
      counts.pending + counts.skipped !== report.numPendingTests || counts.todo !== report.numTodoTests ||
      (report.success && (failedFile || counts.failed > 0 || report.numFailedTestSuites > 0))) return refuse('NOT_PASS_SCHEMA')
  skips.sort((left, right) => {
    const a = JSON.stringify([left.file, left.identitySha256, left.status])
    const b = JSON.stringify([right.file, right.identitySha256, right.status])
    return a < b ? -1 : a > b ? 1 : 0
  })
  let prior = ''
  let occurrence = 0
  for (const skip of skips) {
    const key = JSON.stringify([skip.file, skip.identitySha256, skip.status])
    occurrence = key === prior ? occurrence + 1 : 1
    skip.occurrence = occurrence
    prior = key
  }
  const reasons = []
  if (!report.success || failedFile || counts.failed > 0 || report.numFailedTestSuites > 0) reasons.push('NOT_PASS_ROOT_FAILED')
  if (counts.pending > 0 || report.numPendingTestSuites > 0) reasons.push('NOT_PASS_INCOMPLETE')
  if (outcome(context.pipelineOutcome) !== 'success') reasons.push('NOT_PASS_PIPELINE')
  if (outcome(context.auditOutcome) !== 'success') reasons.push('NOT_PASS_AUDIT')
  const summary = {
    schema: SCHEMA, authority: AUTHORITY, status: reasons[0] ?? 'DIAGNOSTIC_COMPLETE', reasons,
    pipelineOutcome: outcome(context.pipelineOutcome), auditOutcome: outcome(context.auditOutcome),
    counts: Object.fromEntries(COUNT_KEYS.map((key) => [key, report[key]])),
    observed: { files: files.size, assertions, skipped: skips.length, todo: counts.todo },
    skips, inventorySha256: digest(skips)
  }
  if (Buffer.byteLength(JSON.stringify(summary), 'utf8') > MAX_OUTPUT_BYTES) return refuse('NOT_PASS_LIMIT')
  return { exitCode: reasons.length ? 1 : 0, summary }
}

/**
 * Read one unattested report, without starting a test, changing its verdict or writing evidence files.
 * @param {DiagnosticContext} context
 * @param {DiagnosticIO} [io]
 * @returns {DiagnosticResult}
 */
export function diagnoseRootReport(context, io = fs) {
  let roots
  try { roots = trustedContext(context, io) } catch { return refuse('NOT_PASS_CONTEXT') }
  if (roots === null) return refuse('NOT_PASS_CONTEXT')
  if (roots === false) return refuse('NOT_PASS_PATH')
  const reportPath = roots.reportPath
  let before
  try { before = io.lstatSync(reportPath) } catch { return refuse('NOT_PASS_MISSING') }
  if (before.isSymbolicLink() || !before.isFile()) return refuse('NOT_PASS_PATH')
  if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > MAX_REPORT_BYTES) return refuse('NOT_PASS_LIMIT')
  let fd
  let bytes
  try {
    if (io.realpathSync(dirname(reportPath)) !== roots.runnerTemp || io.realpathSync(reportPath) !== reportPath) return refuse('NOT_PASS_PATH')
    fd = io.openSync(reportPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0))
    const opened = io.fstatSync(fd)
    if (opened.size > MAX_REPORT_BYTES) return refuse('NOT_PASS_LIMIT')
    if (!stable(before, opened)) return refuse('NOT_PASS_UNSTABLE')
    const buffer = Buffer.alloc(before.size + 1)
    let size = 0
    while (size < buffer.length) {
      const count = io.readSync(fd, buffer, size, buffer.length - size, null)
      if (!Number.isSafeInteger(count) || count < 0 || count > buffer.length - size) return refuse('NOT_PASS_UNREADABLE')
      if (count === 0) break
      size += count
    }
    if (size > MAX_REPORT_BYTES) return refuse('NOT_PASS_LIMIT')
    const after = io.lstatSync(reportPath)
    if (size !== before.size || after.isSymbolicLink() || !stable(before, after) || !stable(before, io.fstatSync(fd))) {
      return refuse('NOT_PASS_UNSTABLE')
    }
    bytes = buffer.subarray(0, size)
  } catch { return refuse('NOT_PASS_UNREADABLE') } finally {
    if (fd !== undefined) { try { io.closeSync(fd) } catch { return refuse('NOT_PASS_UNREADABLE') } }
  }
  let report
  try { report = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { return refuse('NOT_PASS_SCHEMA') }
  try { return summarize(report, context, roots.workspace, io) } catch { return refuse('NOT_PASS_SCHEMA') }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const env = process.env
  const result = diagnoseRootReport({
    ci: env.CI, githubActions: env.GITHUB_ACTIONS,
    runnerTemp: env.METIS_CI_RUNNER_TEMP, workspace: env.METIS_CI_WORKSPACE,
    runId: env.METIS_CI_RUN_ID, runAttempt: env.METIS_CI_RUN_ATTEMPT, matrixOs: env.METIS_CI_MATRIX_OS,
    reportPath: env.METIS_CI_ROOT_REPORT,
    pipelineOutcome: env.METIS_CI_PIPELINE_OUTCOME, auditOutcome: env.METIS_CI_AUDIT_OUTCOME
  })
  console.log(JSON.stringify(result.summary))
  process.exitCode = result.exitCode
}
