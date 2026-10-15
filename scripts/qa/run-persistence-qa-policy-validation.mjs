#!/usr/bin/env node

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = process.cwd()
const runnerTemp = process.env.RUNNER_TEMP
const reportDirectory = process.env.PERSISTENCE_QA_POLICY_REPORT_DIR
const testFile = 'src/main/persistence/resource-policy.test.ts'
const reportFileName = 'persistence-qa-policy-tests.json'
const statusFileName = 'qualification-status.json'

function isWithin(base, target) {
  const pathFromBase = relative(base, target)
  return (
    pathFromBase !== '' && pathFromBase !== '..' && !pathFromBase.startsWith(`..${sep}`) && !isAbsolute(pathFromBase)
  )
}

function writeStatus(state, details = {}) {
  writeFileSync(
    join(reportDirectory, statusFileName),
    `${JSON.stringify(
      {
        state,
        platform: process.platform,
        node: process.version,
        testFile,
        ...details
      },
      null,
      2
    )}\n`
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
  console.error('Persistence QA policy report directory and RUNNER_TEMP must be absolute paths.')
  process.exit(1)
}

const resolvedReportDirectory = resolve(reportDirectory)
const resolvedRunnerTemp = resolve(runnerTemp)
if (
  resolvedReportDirectory === parse(resolvedReportDirectory).root ||
  resolvedReportDirectory === root ||
  isWithin(root, resolvedReportDirectory) ||
  !isWithin(resolvedRunnerTemp, resolvedReportDirectory) ||
  !existsSync(join(resolvedReportDirectory, statusFileName))
) {
  console.error('Persistence QA policy report directory is not an initialized child of RUNNER_TEMP.')
  process.exit(1)
}

const reportPath = join(resolvedReportDirectory, reportFileName)
writeStatus('running', { phase: 'test-process' })

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
    report.numTotalTestSuites !== report.numPassedTestSuites + report.numFailedTestSuites + report.numPendingTestSuites
  )
    return false

  if (!Array.isArray(report.testResults) || report.testResults.length !== 1) return false
  const matches = report.testResults.filter(
    (entry) => typeof entry.name === 'string' && entry.name.replaceAll('\\', '/').endsWith(`/${testFile}`)
  )
  if (
    matches.length !== 1 ||
    matches[0].status !== 'passed' ||
    !Array.isArray(matches[0].assertionResults) ||
    matches[0].assertionResults.length === 0 ||
    matches[0].assertionResults.some((assertion) => assertion.status !== 'passed')
  )
    return false
  return matches[0].assertionResults.length === report.numTotalTests
}

const vitest = resolve(root, 'node_modules', 'vitest', 'vitest.mjs')
if (!existsSync(vitest)) {
  writeStatus('failed', { phase: 'vitest-missing', exitCode: 1 })
  process.exit(1)
}

if (existsSync(reportPath)) unlinkSync(reportPath)

const result = spawnSync(
  process.execPath,
  [
    vitest,
    'run',
    '--config',
    'vitest.config.ts',
    '--dangerouslyIgnoreUnhandledErrors=false',
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${reportPath}`,
    testFile
  ],
  { cwd: root, env: process.env, stdio: 'inherit', timeout: 20 * 60 * 1000, windowsHide: true }
)

if (result.error || result.status !== 0) {
  writeStatus('failed', {
    phase: 'test-process',
    exitCode: Number.isInteger(result.status) ? result.status : null,
    signal: result.signal ?? null,
    reportPresent: existsSync(reportPath)
  })
  process.exit(1)
}

if (!existsSync(reportPath)) {
  writeStatus('failed', { phase: 'missing-json-report', exitCode: 1 })
  process.exit(1)
}

let report
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'))
} catch {
  writeStatus('failed', { phase: 'invalid-json-report', exitCode: 1 })
  process.exit(1)
}

if (!verifyReport(report)) {
  writeStatus('failed', { phase: 'strict-report-validation', exitCode: 1, testReport: reportPath })
  process.exit(1)
}

writeStatus('passed', {
  phase: 'complete',
  exitCode: 0,
  totalTests: report.numTotalTests,
  passedTests: report.numPassedTests,
  failedTests: report.numFailedTests,
  pendingTests: report.numPendingTests,
  todoTests: report.numTodoTests,
  unhandledErrorGate: 'vitest-process-exit-with-ignore-disabled',
  testReport: reportPath
})
