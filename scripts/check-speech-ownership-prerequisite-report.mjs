#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const [reportPath, resultPath] = process.argv.slice(2)
if (!reportPath || !resultPath) throw new Error('USAGE: check-speech-ownership-prerequisite-report <report> <result>')

const sourceSha = process.env.SOURCE_SHA ?? ''
if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('SPEECH_OWNERSHIP_SOURCE_SHA_INVALID')
const testOutcome = process.env.TEST_OUTCOME ?? 'missing'

const reportBytes = readFileSync(reportPath)
const report = JSON.parse(reportBytes.toString('utf8'))
const requiredFiles = [
  'src/main/features/components/speech-pack/install-admission.test.ts',
  'src/main/infra/storage/runtime-owned-tree.test.ts'
]
const counterNames = [
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
const countersComplete = counterNames.every((key) => Number.isSafeInteger(report[key]) && report[key] >= 0)
const results = Array.isArray(report.testResults) ? report.testResults : []
const normalize = (value) => String(value).replaceAll('\\', '/')
const paths = results.map((result) => normalize(result.name))
const assertions = results.flatMap((result) => (Array.isArray(result.assertionResults) ? result.assertionResults : []))
const exactInventory =
  results.length === requiredFiles.length &&
  requiredFiles.every((path) => paths.filter((actual) => actual.endsWith(`/${path}`)).length === 1)
const complete =
  countersComplete &&
  testOutcome === 'success' &&
  report.success === true &&
  exactInventory &&
  results.every(
    (result) =>
      result.status === 'passed' && Array.isArray(result.assertionResults) && result.assertionResults.length > 0
  ) &&
  assertions.length === report.numTotalTests &&
  assertions.every((assertion) => assertion.status === 'passed') &&
  report.numTotalTests === 11 &&
  report.numPassedTests === 11 &&
  report.numFailedTests === 0 &&
  report.numPendingTests === 0 &&
  report.numTodoTests === 0 &&
  report.numTotalTestSuites === 4 &&
  report.numPassedTestSuites === 4 &&
  report.numFailedTestSuites === 0 &&
  report.numPendingTestSuites === 0

const qualification = {
  sourceSha,
  runnerOs: process.env.RUNNER_OS ?? null,
  platform: process.platform,
  architecture: process.arch,
  testOutcome,
  reportSha256: createHash('sha256').update(reportBytes).digest('hex'),
  files: paths,
  counts: {
    tests: report.numTotalTests,
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    pending: report.numPendingTests,
    todo: report.numTodoTests,
    suites: report.numTotalTestSuites,
    passedSuites: report.numPassedTestSuites,
    failedSuites: report.numFailedTestSuites,
    pendingSuites: report.numPendingTestSuites
  }
}
writeFileSync(resultPath, `${JSON.stringify(qualification, null, 2)}\n`, { flag: 'wx' })
process.stdout.write(`${JSON.stringify(qualification)}\n`)
if (!complete) throw new Error('SPEECH_OWNERSHIP_PREREQUISITE_REPORT_REJECTED')
