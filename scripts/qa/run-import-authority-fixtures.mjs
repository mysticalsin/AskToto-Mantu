#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import {
  createWriteStream,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

const root = process.cwd()
const reportDirectory = process.env.IMPORT_AUTHORITY_REPORT_DIR
const runnerTemp = process.env.RUNNER_TEMP
const fileDeadlineMs = 90_000
const terminationDeadlineMs = 6_000
const drainDeadlineMs = 4_000
const maxRawLogBytes = 8 * 1024 * 1024
const maxJsonReadBytes = 16 * 1024 * 1024
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

function atomicJson(path, value) {
  const temporaryPath = `${path}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'w' })
  renameSync(temporaryPath, path)
}

function requiredCounters(report) {
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
  if (counterNames.some((key) => !Number.isSafeInteger(report?.[key]) || report[key] < 0)) return null
  return Object.fromEntries(counterNames.map((key) => [key, report[key]]))
}

function inspectReport(report, file) {
  const counts = requiredCounters(report)
  const diagnostic = {
    counts,
    success: report?.success === true,
    totalTestResults: Array.isArray(report?.testResults) ? report.testResults.length : null,
    assertionCount: null,
    failure: null
  }
  if (!counts) {
    diagnostic.failure = 'report-counters-missing-or-invalid'
    return diagnostic
  }
  // Vitest's supported JSON result has no unhandledErrors field. Its real exit
  // status and success/counters remain authoritative; never invent that field.
  if (Object.hasOwn(report, 'unhandledErrors') && !Array.isArray(report.unhandledErrors)) {
    diagnostic.failure = 'unhandled-errors-field-invalid'
    return diagnostic
  }
  if (Array.isArray(report.unhandledErrors) && report.unhandledErrors.length !== 0) {
    diagnostic.failure = 'unhandled-errors-present'
    return diagnostic
  }
  if (!Array.isArray(report.testResults) || report.testResults.length !== 1) {
    diagnostic.failure = 'expected-one-file-result'
    return diagnostic
  }
  const result = report.testResults[0]
  const normalizedName = typeof result?.name === 'string' ? result.name.replaceAll('\\', '/') : ''
  const assertions = Array.isArray(result?.assertionResults) ? result.assertionResults : null
  diagnostic.assertionCount = assertions?.length ?? null
  if (!normalizedName.endsWith(`/${file}`)) {
    diagnostic.failure = 'unexpected-file-result-name'
    return diagnostic
  }
  if (result.status !== 'passed' || !assertions || assertions.length === 0) {
    diagnostic.failure = 'file-or-assertion-result-not-passed'
    return diagnostic
  }
  if (assertions.some((assertion) => assertion.status !== 'passed')) {
    diagnostic.failure = 'failed-pending-or-todo-assertion'
    return diagnostic
  }
  if (
    counts.numTotalTests !== assertions.length ||
    counts.numPassedTests !== counts.numTotalTests ||
    counts.numFailedTests !== 0 ||
    counts.numPendingTests !== 0 ||
    counts.numTodoTests !== 0 ||
    counts.numTotalTestSuites <= 0 ||
    counts.numPassedTestSuites !== counts.numTotalTestSuites ||
    counts.numFailedTestSuites !== 0 ||
    counts.numPendingTestSuites !== 0 ||
    report.success !== true
  ) {
    diagnostic.failure = 'strict-file-counts-mismatch'
    return diagnostic
  }
  return diagnostic
}

function groupExists(pid) {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

function signalChildGroup(pid, signal) {
  try {
    process.kill(-pid, signal)
    return true
  } catch (error) {
    return error?.code === 'ESRCH'
  }
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

async function terminatePosixGroup(pid) {
  if (!signalChildGroup(pid, 'SIGTERM')) return { state: 'unknown', detail: 'SIGTERM could-not-target-child-group' }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!groupExists(pid)) return { state: 'confirmed', signal: 'SIGTERM' }
    await delay(100)
  }
  if (!signalChildGroup(pid, 'SIGKILL')) {
    return { state: 'unknown', detail: 'SIGKILL-could-not-target-child-group' }
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!groupExists(pid)) return { state: 'confirmed', signal: 'SIGKILL' }
    await delay(100)
  }
  return { state: 'unknown', detail: 'child-group-still-present-after-SIGKILL' }
}

async function terminateWindowsTree(pid) {
  const reaper = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
    cwd: root,
    env: process.env,
    stdio: 'ignore',
    windowsHide: true,
    shell: false
  })
  let spawnError = null
  const closed = new Promise((resolvePromise) => {
    reaper.once('error', (error) => {
      spawnError = error
    })
    reaper.once('close', (code, signal) => resolvePromise({ code, signal, spawnError }))
  })
  let result = await withinDeadline(closed, 3_500, 'taskkill-deadline')
  if (!result.completed) {
    try {
      reaper.kill('SIGTERM')
    } catch {
      reaper.unref()
      return { state: 'unknown', detail: 'taskkill-reaper-timeout-and-termination-failed' }
    }
    result = await withinDeadline(closed, 500, 'taskkill-termination-deadline')
    if (!result.completed) {
      try {
        reaper.kill('SIGKILL')
      } catch {
        reaper.unref()
        return { state: 'unknown', detail: 'taskkill-reaper-did-not-exit-or-terminate' }
      }
      const forced = await withinDeadline(closed, 500, 'taskkill-forced-deadline')
      if (!forced.completed) {
        reaper.unref()
        return { state: 'unknown', detail: 'taskkill-reaper-survived-forced-termination' }
      }
      return { state: 'unknown', detail: 'taskkill-reaper-exceeded-deadline' }
    }
    return { state: 'unknown', detail: 'taskkill-reaper-exceeded-deadline' }
  }
  result = result.value
  if (result.code === 0 && !result.spawnError) return { state: 'confirmed', method: 'taskkill-tree' }
  return {
    state: 'unknown',
    detail: 'taskkill-tree-failed',
    exitCode: result.code,
    signal: result.signal,
    errorCode: result.spawnError?.code ?? null
  }
}

async function terminateChildTree(child) {
  if (!Number.isInteger(child.pid)) return { state: 'unknown', detail: 'child-pid-unavailable' }
  if (process.platform === 'win32') return terminateWindowsTree(child.pid)
  return terminatePosixGroup(child.pid)
}

function withinDeadline(promise, timeoutMs, label) {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise({ completed: false, label }), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolvePromise({ completed: true, value })
      },
      (error) => {
        clearTimeout(timer)
        resolvePromise({ completed: true, error })
      }
    )
  })
}

function assertionFailureNames(report) {
  if (!Array.isArray(report?.testResults)) return []
  return report.testResults.flatMap((fileResult) => {
    if (!Array.isArray(fileResult?.assertionResults)) return []
    return fileResult.assertionResults
      .filter((assertion) => assertion?.status !== 'passed')
      .map(
        (assertion) =>
          assertion.fullName ?? assertion.title ?? assertion.ancestorTitles?.join(' › ') ?? '(unnamed assertion)'
      )
  })
}

async function runFile({ file, index, vitest, reportPath, rawPath, head, inventory, persistInventory }) {
  if (existsSync(reportPath) || existsSync(rawPath)) {
    return {
      state: 'failed',
      file,
      head,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      phase: 'report-path-already-exists',
      exitCode: null,
      signal: null,
      timedOut: false,
      errorCode: null,
      jsonPresent: existsSync(reportPath),
      report: null,
      rawLog: rawPath,
      safeToContinue: true
    }
  }

  const startedAt = new Date().toISOString()
  const entry = inventory.files[index]
  Object.assign(entry, { state: 'running', startedAt, head, rawLog: rawPath, jsonReport: reportPath })
  persistInventory()
  const raw = createWriteStream(rawPath, { flags: 'wx' })
  const rawClosed = new Promise((resolvePromise) => raw.once('close', resolvePromise))
  let rawError = null
  raw.once('error', (error) => {
    rawError = error
  })
  const child = spawn(
    process.execPath,
    [
      vitest,
      'run',
      '--config',
      'vitest.config.ts',
      '--reporter=default',
      '--reporter=json',
      '--dangerouslyIgnoreUnhandledErrors=false',
      `--outputFile.json=${reportPath}`,
      file
    ],
    {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      detached: process.platform !== 'win32'
    }
  )
  let childError = null
  let rawBytes = 0
  let rawTruncated = false
  const appendRaw = (chunk, source) => {
    const remaining = maxRawLogBytes - rawBytes
    const accepted = remaining > 0 ? chunk.subarray(0, remaining) : Buffer.alloc(0)
    rawBytes += accepted.length
    if (accepted.length !== chunk.length) rawTruncated = true
    if (accepted.length > 0 && !raw.write(accepted)) {
      source.pause()
      raw.once('drain', () => source.resume())
    }
  }
  child.stdout?.on('data', (chunk) => appendRaw(chunk, child.stdout))
  child.stderr?.on('data', (chunk) => appendRaw(chunk, child.stderr))
  const closePromise = new Promise((resolvePromise) => {
    child.once('close', (code, signal) => resolvePromise({ code, signal }))
    child.once('error', (error) => {
      childError = error
    })
  })
  const deadlineResult = await withinDeadline(closePromise, fileDeadlineMs, 'file-deadline')
  const timedOut = !deadlineResult.completed
  let result = deadlineResult.completed ? deadlineResult.value : { code: null, signal: null }
  let cleanupResult = null
  let safeToContinue = true
  if (timedOut) {
    const cleanupDeadline = await withinDeadline(
      terminateChildTree(child),
      terminationDeadlineMs,
      'termination-deadline'
    )
    cleanupResult =
      cleanupDeadline.completed && cleanupDeadline.value
        ? cleanupDeadline.value
        : { state: 'unknown', detail: cleanupDeadline.label ?? 'termination-failed' }
    let drained = await withinDeadline(closePromise, drainDeadlineMs, 'child-close-deadline')
    if (!drained.completed) {
      try {
        child.kill('SIGKILL')
      } catch {
        // Unknown cleanup below prevents another fixture from starting.
      }
      drained = await withinDeadline(closePromise, 1_000, 'forced-child-close-deadline')
    }
    if (drained.completed) result = drained.value
    safeToContinue = cleanupResult.state === 'confirmed' && drained.completed
    if (!safeToContinue) {
      cleanupResult = {
        ...cleanupResult,
        state: 'unknown',
        closeState: drained.completed ? 'closed' : 'still-open'
      }
      child.stdout?.destroy()
      child.stderr?.destroy()
      child.unref()
    }
  }
  raw.end()
  const rawResult = await withinDeadline(rawClosed, 2_000, 'raw-log-close-deadline')
  if (!rawResult.completed) {
    raw.destroy()
    rawError ??= new Error('raw-log-close-deadline')
  }

  let report = null
  let reportDiagnostic = null
  let jsonPresent = existsSync(reportPath)
  let jsonBytes = null
  if (jsonPresent) {
    try {
      jsonBytes = statSync(reportPath).size
      if (jsonBytes > maxJsonReadBytes) {
        reportDiagnostic = { failure: 'json-report-over-read-limit', jsonBytes, maxJsonReadBytes }
      } else {
        report = JSON.parse(readFileSync(reportPath, 'utf8'))
        reportDiagnostic = inspectReport(report, file)
      }
    } catch (error) {
      reportDiagnostic = {
        failure: 'invalid-json-report',
        errorCode: error?.code ?? null,
        error: error?.message ?? String(error)
      }
    }
  }
  const childExitedSuccessfully = result.code === 0 && result.signal === null && !childError
  const passed =
    childExitedSuccessfully && !timedOut && cleanupResult === null && !rawError && reportDiagnostic?.failure === null
  const state = passed ? 'passed' : timedOut ? 'timed-out' : 'failed'
  const finalEntry = {
    state,
    file,
    head,
    startedAt,
    endedAt: new Date().toISOString(),
    exitCode: Number.isInteger(result.code) ? result.code : null,
    signal: result.signal ?? null,
    timedOut,
    errorCode: childError?.code ?? rawError?.code ?? null,
    error: childError?.message ?? rawError?.message ?? null,
    timeoutMs: fileDeadlineMs,
    cleanup: cleanupResult ?? { state: 'not-needed' },
    safeToContinue,
    jsonPresent,
    jsonBytes,
    report: reportDiagnostic,
    rawLog: rawPath,
    rawBytes,
    rawTruncated,
    jsonReport: reportPath
  }
  Object.assign(entry, finalEntry)
  persistInventory()
  console.log(
    JSON.stringify({
      event: 'import-authority-file',
      file,
      state,
      exitCode: finalEntry.exitCode,
      signal: finalEntry.signal,
      timedOut,
      cleanup: finalEntry.cleanup,
      counts: reportDiagnostic?.counts ?? null,
      failure: reportDiagnostic?.failure ?? (reportDiagnostic ? null : 'json-report-missing'),
      namedFailures: assertionFailureNames(report),
      rawBytes,
      rawTruncated,
      jsonBytes
    })
  )
  return finalEntry
}

if (
  typeof reportDirectory !== 'string' ||
  reportDirectory.length === 0 ||
  !isAbsolute(reportDirectory) ||
  typeof runnerTemp !== 'string' ||
  runnerTemp.length === 0 ||
  !isAbsolute(runnerTemp)
) {
  console.error('Import authority report directory and RUNNER_TEMP must be absolute paths.')
  process.exit(1)
}

let resolvedReportDirectory
let resolvedRunnerTemp
try {
  resolvedReportDirectory = realpathSync(resolve(reportDirectory))
  resolvedRunnerTemp = realpathSync(resolve(runnerTemp))
  if (!lstatSync(resolve(reportDirectory)).isDirectory()) throw new Error('report-path-is-not-a-directory')
} catch {
  console.error('Import authority report directory must be an existing initialized directory.')
  process.exit(1)
}
if (
  resolvedReportDirectory === parse(resolvedReportDirectory).root ||
  resolvedReportDirectory === realpathSync(root) ||
  isWithin(realpathSync(root), resolvedReportDirectory) ||
  !isWithin(resolvedRunnerTemp, resolvedReportDirectory)
) {
  console.error('Import authority report directory is outside the allowed runner-temp location.')
  process.exit(1)
}

const statusPath = join(resolvedReportDirectory, 'qualification-status.json')
const inventoryPath = join(resolvedReportDirectory, 'import-authority-inventory.json')
if (!existsSync(statusPath) || lstatSync(statusPath).size === 0 || existsSync(inventoryPath)) {
  console.error('Import authority report directory has no fresh nonempty workflow initialization status.')
  process.exit(1)
}
let initialization
try {
  initialization = JSON.parse(readFileSync(statusPath, 'utf8'))
} catch {
  console.error('Import authority workflow initialization status is invalid JSON.')
  process.exit(1)
}
if (initialization.state !== 'not-started' || initialization.phase !== 'before-install') {
  console.error('Import authority report directory was not initialized by the expected workflow step.')
  process.exit(1)
}
const existingFiles = readdirSync(resolvedReportDirectory).sort()
if (existingFiles.length !== 1 || existingFiles[0] !== 'qualification-status.json') {
  console.error('Import authority report directory is not fresh and exclusively owned by this run.')
  process.exit(1)
}

const gitHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', shell: false })
if (gitHead.status !== 0 || !/^[0-9a-f]{40,64}\s*$/i.test(gitHead.stdout ?? '')) {
  atomicJson(statusPath, { state: 'failed', phase: 'head-resolution', exitCode: gitHead.status ?? 1 })
  console.error('Unable to record the exact source HEAD for Import authority reports.')
  process.exit(1)
}
const head = gitHead.stdout.trim()
const inventory = {
  state: 'running',
  head,
  platform: process.platform,
  runnerOs: process.env.RUNNER_OS ?? null,
  node: process.version,
  initializedAt: new Date().toISOString(),
  fileDeadlineMs,
  terminationDeadlineMs,
  drainDeadlineMs,
  maxRawLogBytes,
  maxJsonReadBytes,
  testFiles,
  files: testFiles.map((file) => ({ file, state: 'not-started' }))
}
const persistInventory = () => atomicJson(inventoryPath, inventory)
const status = (state, details = {}) =>
  atomicJson(statusPath, {
    state,
    head,
    platform: process.platform,
    runnerOs: process.env.RUNNER_OS ?? null,
    node: process.version,
    testFiles,
    inventory: inventoryPath,
    ...details
  })

persistInventory()
status('running', { phase: 'per-file-tests', completedFiles: 0 })
const vitest = resolve(root, 'node_modules', 'vitest', 'vitest.mjs')
if (!existsSync(vitest)) {
  for (const entry of inventory.files) Object.assign(entry, { state: 'not-run', phase: 'vitest-missing' })
  persistInventory()
  status('failed', { phase: 'vitest-missing', exitCode: 1, completedFiles: 0 })
  process.exit(1)
}

let completedFiles = 0
let allPassed = true
for (let index = 0; index < testFiles.length; index += 1) {
  const file = testFiles[index]
  const basename = file
    .replaceAll('/', '__')
    .replaceAll('\\', '__')
    .replace(/[^A-Za-z0-9_.-]/g, '_')
  const stem = `${String(index + 1).padStart(2, '0')}-${basename}`
  const reportPath = join(resolvedReportDirectory, `${stem}.json`)
  const rawPath = join(resolvedReportDirectory, `${stem}.raw.log`)
  status('running', { phase: 'file-running', activeFile: file, completedFiles })
  let result
  try {
    result = await runFile({
      file,
      index,
      vitest,
      reportPath,
      rawPath,
      head,
      inventory,
      persistInventory
    })
  } catch (error) {
    result = {
      state: 'failed',
      file,
      head,
      startedAt: inventory.files[index].startedAt ?? null,
      endedAt: new Date().toISOString(),
      phase: 'runner-error',
      exitCode: null,
      signal: null,
      timedOut: false,
      errorCode: error?.code ?? null,
      error: error?.message ?? String(error),
      jsonPresent: existsSync(reportPath),
      safeToContinue: false,
      rawLog: rawPath,
      jsonReport: reportPath
    }
    Object.assign(inventory.files[index], result)
    persistInventory()
  }
  completedFiles += 1
  if (result.state !== 'passed') allPassed = false
  status('running', {
    phase: 'file-finished',
    lastFile: result,
    completedFiles,
    passedFiles: inventory.files.filter((entry) => entry.state === 'passed').length,
    failedFiles: inventory.files.filter((entry) => entry.state === 'failed' || entry.state === 'timed-out').length
  })
  if (!result.safeToContinue) {
    for (let remainingIndex = index + 1; remainingIndex < testFiles.length; remainingIndex += 1) {
      Object.assign(inventory.files[remainingIndex], {
        state: 'not-run',
        phase: 'prior-child-cleanup-unknown'
      })
    }
    persistInventory()
    break
  }
}

const finalState = allPassed ? 'passed' : 'failed'
inventory.state = finalState
inventory.completedAt = new Date().toISOString()
persistInventory()
const failedFiles = inventory.files.filter((entry) => entry.state !== 'passed')
const reportedFiles = inventory.files.filter((entry) => entry.report?.counts)
const reportedCountTotals = Object.fromEntries(
  [
    'numTotalTests',
    'numPassedTests',
    'numFailedTests',
    'numPendingTests',
    'numTodoTests',
    'numTotalTestSuites',
    'numPassedTestSuites',
    'numFailedTestSuites',
    'numPendingTestSuites'
  ].map((key) => [key, reportedFiles.reduce((total, entry) => total + entry.report.counts[key], 0)])
)
status(finalState, {
  phase: allPassed ? 'complete' : 'one-or-more-files-failed',
  completedFiles,
  passedFiles: testFiles.length - failedFiles.length,
  failedFiles,
  filesWithReportedCounts: reportedFiles.length,
  reportedCountTotals
})
if (!allPassed) process.exitCode = 1
