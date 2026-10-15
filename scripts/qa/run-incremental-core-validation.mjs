#!/usr/bin/env node

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = process.cwd()
const electronVersion = '43.6.0'
const workerLoader = join(root, 'out', 'main', 'meeting-speech-worker.js')
const workerBytecode = join(root, 'out', 'main', 'meeting-speech-worker.jsc')
const sharedTestFiles = [
  'src/main/features/meetings/incremental-record-canonical.test.ts',
  'src/main/features/meetings/incremental-meeting-journal-format.test.ts',
  'src/main/features/meetings/incremental-meeting-journal.test.ts',
  'src/main/features/meetings/incremental-meeting-journal-files.test.ts',
  'src/main/features/meetings/meeting-public-projection.test.ts',
  'src/main/infra/storage/gateway.test.ts',
  'src/main/infra/storage/gateway-stream.test.ts',
  'src/main/infra/storage/atomic-saved-write-stream.test.ts'
]
const posixTestFiles = ['src/main/infra/storage/gateway-fifo-posix.test.ts']
const testFilesByPlatform = {
  linux: [...sharedTestFiles, ...posixTestFiles],
  darwin: [...sharedTestFiles, ...posixTestFiles],
  win32: sharedTestFiles
}
if (!Object.hasOwn(testFilesByPlatform, process.platform))
  throw new Error(`Incremental core qualification does not support ${process.platform}.`)
const testFiles = testFilesByPlatform[process.platform]
const electronTest = 'scripts/qa/fixtures/incremental-meeting-speech-worker.integration.electron-case.ts'
const electronBinary =
  process.platform === 'win32'
    ? join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
    : process.platform === 'darwin'
      ? join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
      : join(root, 'node_modules', 'electron', 'dist', 'electron')

function requireBuiltWorker() {
  if (!existsSync(workerLoader) || !existsSync(workerBytecode)) throw new Error('Built worker pair is missing.')
  const source = readFileSync(workerLoader, 'utf8')
  if (!source.includes('bytecode-loader.cjs') || !source.includes('meeting-speech-worker.jsc'))
    throw new Error('Built worker loader does not resolve its bytecode sibling.')
  if (!existsSync(electronBinary)) throw new Error('Pinned Electron executable is missing.')
}

function execute(executable, args, env, timeout) {
  const result = spawnSync(executable, args, {
    cwd: root,
    env,
    stdio: 'inherit',
    timeout,
    windowsHide: true
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Validation process exited with status ${result.status ?? 'unknown'}.`)
}

function verifyReport(path, requiredFiles, phase) {
  if (!existsSync(path)) throw new Error(`${phase} test report is missing.`)
  const report = JSON.parse(readFileSync(path, 'utf8'))
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
  if (counters.some((key) => !Number.isSafeInteger(report[key]) || report[key] < 0))
    throw new Error(`${phase} test counters are missing or invalid.`)
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
    throw new Error(`${phase} tests failed, skipped, or returned an empty result.`)
  if (!Array.isArray(report.testResults) || report.testResults.length !== requiredFiles.length)
    throw new Error(`${phase} test-file inventory differs from the required inventory.`)
  let assertions = 0
  for (const file of requiredFiles) {
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
      throw new Error(`${phase} required file did not pass every assertion.`)
    assertions += matches[0].assertionResults.length
  }
  if (assertions !== report.numTotalTests) throw new Error(`${phase} assertion count differs from test total.`)
  console.log(`${phase}: ${report.numPassedTests}/${report.numTotalTests}; no failed, pending, or todo cases.`)
}

const reportDirectory =
  process.env.INCREMENTAL_CORE_REPORT_DIR ?? mkdtempSync(join(tmpdir(), 'metis-incremental-core-'))
mkdirSync(reportDirectory, { recursive: true })
const nodeReport = join(reportDirectory, 'node-tests.json')
const electronReport = join(reportDirectory, 'electron-worker.json')
for (const report of [nodeReport, electronReport]) rmSync(report, { force: true })
console.log(`Incremental core reports retained at ${reportDirectory}`)
console.log(
  `Required ${process.platform} test files: ${testFiles.length}; POSIX FIFO suite selected: ${process.platform !== 'win32'}`
)
try {
  requireBuiltWorker()
  const vitest = resolve(root, 'node_modules', 'vitest', 'vitest.mjs')
  execute(
    process.execPath,
    [
      vitest,
      'run',
      '--config',
      'vitest.config.ts',
      '--reporter=default',
      '--reporter=github-actions',
      '--reporter=json',
      `--outputFile.json=${nodeReport}`,
      ...testFiles
    ],
    process.env,
    30 * 60 * 1000
  )
  verifyReport(nodeReport, testFiles, 'Incremental core')

  execute(
    electronBinary,
    [
      resolve(vitest),
      'run',
      '--config',
      'vitest.incremental-worker.config.ts',
      '--reporter=default',
      '--reporter=github-actions',
      '--reporter=json',
      `--outputFile.json=${electronReport}`,
      electronTest
    ],
    { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    10 * 60 * 1000
  )
  verifyReport(electronReport, [electronTest], 'Compiled Electron worker')
} catch (error) {
  for (const report of [nodeReport, electronReport]) {
    if (existsSync(report)) console.error(`Retained validation report: ${report}`)
  }
  throw error
}
