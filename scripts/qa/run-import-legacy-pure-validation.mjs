#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = process.cwd()
const testFile = 'src/main/import-legacy-checkpoint-reader.test.ts'
const expectedCases = 44
const reportDirectory = process.env.IMPORT_LEGACY_REPORT_DIR
if (!reportDirectory) throw new Error('IMPORT_LEGACY_REPORT_DIR is required for the strict pure-test inventory.')
mkdirSync(reportDirectory, { recursive: true })
const reportPath = join(reportDirectory, 'pure-reader.json')
const vitest = resolve(root, 'node_modules/vitest/vitest.mjs')
if (!existsSync(vitest)) throw new Error('Installed Vitest entry point is missing.')
rmSync(reportPath, { force: true })
const result = spawnSync(
  process.execPath,
  [vitest, 'run', testFile, '--reporter=default', '--reporter=json', `--outputFile.json=${reportPath}`],
  { cwd: root, env: process.env, stdio: 'inherit', windowsHide: true }
)
if (result.error) throw result.error
if (!existsSync(reportPath)) throw new Error('Vitest did not write the required pure-test JSON inventory.')

const report = JSON.parse(readFileSync(reportPath, 'utf8'))
const testResults = report.testResults
const file = Array.isArray(testResults) && testResults.length === 1 ? testResults[0] : undefined
const assertions = Array.isArray(file?.assertionResults) ? file.assertionResults : []
const statusCounts = { passed: 0, failed: 0, skipped: 0, pending: 0, todo: 0, other: 0 }
for (const assertion of assertions) {
  if (assertion.status === 'passed') statusCounts.passed += 1
  else if (assertion.status === 'failed') statusCounts.failed += 1
  else if (assertion.status === 'skip' || assertion.status === 'skipped') statusCounts.skipped += 1
  else if (assertion.status === 'pending') statusCounts.pending += 1
  else if (assertion.status === 'todo') statusCounts.todo += 1
  else statusCounts.other += 1
}
const diagnostics = {
  actualFile: typeof file?.name === 'string' ? file.name.replaceAll('\\', '/') : null,
  expectedFile: testFile,
  expectedCases,
  reportCounts: {
    total: report.numTotalTests,
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    skipped: report.numSkippedTests ?? statusCounts.skipped,
    pending: report.numPendingTests,
    todo: report.numTodoTests
  },
  assertionStatusCounts: statusCounts,
  failedAssertions: assertions
    .filter((assertion) => assertion.status === 'failed')
    .map((assertion) => ({
      title: [...(Array.isArray(assertion.ancestorTitles) ? assertion.ancestorTitles : []), assertion.title].join(
        ' › '
      ),
      errors: Array.isArray(assertion.failureMessages) ? assertion.failureMessages : []
    }))
}
console.log(JSON.stringify(diagnostics, null, 2))

const actualFileMatches = typeof file?.name === 'string' && resolve(file.name) === resolve(root, testFile)
const reportInventoryMatches =
  file !== undefined &&
  file.status === (report.numFailedTests === 0 ? 'passed' : 'failed') &&
  assertions.length === expectedCases &&
  report.numTotalTests === expectedCases &&
  report.numPassedTests === statusCounts.passed &&
  report.numFailedTests === statusCounts.failed &&
  report.numPendingTests === statusCounts.pending &&
  report.numTodoTests === statusCounts.todo &&
  (report.numSkippedTests ?? statusCounts.skipped) === statusCounts.skipped &&
  report.success === (statusCounts.failed === 0 && statusCounts.other === 0)
if (!actualFileMatches || !reportInventoryMatches)
  throw new Error('Pure reader report has the wrong file, count, or incomplete status inventory.')
if (result.status !== 0) {
  process.exitCode = result.status ?? 1
} else if (
  report.numTotalTests <= 0 ||
  statusCounts.failed !== 0 ||
  statusCounts.skipped !== 0 ||
  statusCounts.pending !== 0 ||
  statusCounts.todo !== 0 ||
  statusCounts.other !== 0 ||
  statusCounts.passed !== expectedCases
) {
  throw new Error('Pure reader qualification requires every registered case to pass with no skips or incomplete cases.')
}
