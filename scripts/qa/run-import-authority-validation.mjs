#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = process.cwd()
const reportDirectory = process.env.IMPORT_AUTHORITY_REPORT_DIR
const runnerTemp = process.env.RUNNER_TEMP
const testFiles = [
  'src/main/import-job-authority.test.ts',
  'src/main/import-persistence-policy.test.ts',
  'src/main/import-legacy-origin.test.ts',
  'src/main/import-journal-checkpoint-repository.test.ts',
  'src/main/import-journal-checkpoint-repository.files.test.ts',
  'src/main/import-jobs.summary-only.test.ts',
  'src/main/import-job-store.summary-only.test.ts',
  'src/main/ipc/import-jobs.test.ts',
  'src/main/settings-authority-history.test.ts',
  'src/main/settings-observation.test.ts',
  'src/main/store.test.ts',
  'src/main/fresh-lean-speech-defaults.test.ts'
]

function isWithin(base, target) {
  const pathFromBase = relative(base, target)
  return (
    pathFromBase !== '' && pathFromBase !== '..' && !pathFromBase.startsWith(`..${sep}`) && !isAbsolute(pathFromBase)
  )
}

if (
  typeof reportDirectory !== 'string' ||
  reportDirectory.length === 0 ||
  !isAbsolute(reportDirectory) ||
  typeof runnerTemp !== 'string' ||
  runnerTemp.length === 0 ||
  !isAbsolute(runnerTemp)
) {
  console.error('Import authority report directory is missing or not absolute.')
  process.exit(1)
}

const resolvedReportDirectory = resolve(reportDirectory)
const resolvedRunnerTemp = resolve(runnerTemp)
if (
  resolvedReportDirectory === parse(resolvedReportDirectory).root ||
  resolvedReportDirectory === root ||
  isWithin(root, resolvedReportDirectory) ||
  !isWithin(resolvedRunnerTemp, resolvedReportDirectory)
) {
  console.error('Import authority report directory is outside the allowed runner-temp location.')
  process.exit(1)
}

mkdirSync(resolvedReportDirectory, { recursive: true })
const reportPath = join(resolvedReportDirectory, 'import-authority-tests.json')
const statusPath = join(resolvedReportDirectory, 'qualification-status.json')
const status = {
  state: 'running',
  platform: process.platform,
  node: process.version,
  testFiles,
  posixFifoTests: 'not selected by this import suite; see incremental core qualification for platform roster'
}
writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`)

function finish(state, details = {}) {
  writeFileSync(statusPath, `${JSON.stringify({ ...status, state, ...details }, null, 2)}\n`)
}

function verifyReport(report) {
  const counters = [
    'numTotalTests',
    'numPassedTests',
    'numFailedTests',
    'numPendingTests',
    'numTodoTests',
    'numTotalTestSuites',
    'numPassedTestSuites',
    'numFailedTestSuites',
    'numPendingTestSuites'
  ]
  if (counters.some((key) => !Number.isSafeInteger(report[key]) || report[key] < 0)) return false
  if (
    report.success !== true ||
    report.numTotalTests <= 0 ||
    report.numPassedTests !== report.numTotalTests ||
    report.numFailedTests !== 0 ||
    report.numPendingTests !== 0 ||
    report.numTodoTests !== 0 ||
    report.numFailedTestSuites !== 0 ||
    report.numPendingTestSuites !== 0 ||
    report.numPassedTestSuites <= 0 ||
    report.numTotalTestSuites !==
      report.numPassedTestSuites + report.numFailedTestSuites + report.numPendingTestSuites ||
    (Array.isArray(report.unhandledErrors) && report.unhandledErrors.length !== 0)
  )
    return false
  if (!Array.isArray(report.testResults) || report.testResults.length !== testFiles.length) return false

  let assertions = 0
  for (const file of testFiles) {
    const matches = report.testResults.filter(
      (entry) => typeof entry.name === 'string' && entry.name.replaceAll('\\', '/').endsWith(`/${file}`)
    )
    if (
      matches.length !== 1 ||
      matches[0].status !== 'passed' ||
      !Array.isArray(matches[0].assertionResults) ||
      matches[0].assertionResults.length === 0 ||
      matches[0].assertionResults.some((assertion) => assertion.status !== 'passed')
    )
      return false
    assertions += matches[0].assertionResults.length
  }
  return assertions === report.numTotalTests
}

const vitest = resolve(root, 'node_modules', 'vitest', 'vitest.mjs')
if (!existsSync(vitest)) {
  finish('failed', { phase: 'vitest-missing', exitCode: 1 })
  process.exit(1)
}

const result = spawnSync(
  process.execPath,
  [
    vitest,
    'run',
    '--config',
    'vitest.config.ts',
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${reportPath}`,
    ...testFiles
  ],
  { cwd: root, env: process.env, stdio: 'inherit', timeout: 30 * 60 * 1000, windowsHide: true }
)

if (result.error || result.status !== 0) {
  finish('failed', {
    phase: 'test-process',
    exitCode: Number.isInteger(result.status) ? result.status : null,
    signal: result.signal ?? null,
    reportPresent: existsSync(reportPath)
  })
  process.exit(1)
}

if (!existsSync(reportPath)) {
  finish('failed', { phase: 'missing-json-report', exitCode: 1 })
  process.exit(1)
}

let report
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'))
} catch {
  finish('failed', { phase: 'invalid-json-report', exitCode: 1 })
  process.exit(1)
}

if (!verifyReport(report)) {
  finish('failed', { phase: 'strict-report-validation', exitCode: 1, testReport: reportPath })
  process.exit(1)
}

finish('passed', {
  phase: 'complete',
  exitCode: 0,
  totalTests: report.numTotalTests,
  passedTests: report.numPassedTests,
  failedTests: report.numFailedTests,
  pendingTests: report.numPendingTests,
  todoTests: report.numTodoTests,
  testReport: reportPath
})
