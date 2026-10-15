import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const reporterPath = fileURLToPath(import.meta.url)
const reporterSha256 = createHash('sha256').update(readFileSync(reporterPath)).digest('hex')
const outputPath = process.env.QA_OWNER_FRAMEWORK_REPORT_PATH
let context = null
let initCount = 0
let runEndCount = 0
let runEndReason = null
let runEndUnhandledCount = null
let closeCallbackCount = 0
let cachedCloseObserved = false
let frameworkClosed = false
let closeFailed = false
let timedOut = false

function safeCount(value) {
  return Array.isArray(value) && Number.isSafeInteger(value.length) ? value.length : null
}

function publishAtExit() {
  let sourceHead = null
  let finalUnhandledCount = null
  try {
    sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    // Missing checkout identity invalidates this record.
  }
  try {
    finalUnhandledCount = safeCount(context?.state?.getUnhandledErrors())
  } catch {
    // A failed final framework read cannot be treated as zero errors.
  }
  const runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT)
  const bindingValid =
    /^[a-f0-9]{40}$/.test(sourceHead ?? '') &&
    sourceHead === process.env.QA_OWNER_SOURCE_SHA &&
    sourceHead === process.env.GITHUB_SHA &&
    /^[1-9][0-9]*$/.test(process.env.GITHUB_RUN_ID ?? '') &&
    /^[1-9][0-9]*$/.test(process.env.GITHUB_RUN_ATTEMPT ?? '') &&
    Number.isSafeInteger(runAttempt) &&
    ['linux-shipping', 'windows-x64', 'macos-x64', 'macos-arm64'].includes(process.env.QA_OWNER_TARGET) &&
    process.version === 'v22.22.3'
  const complete =
    bindingValid &&
    initCount === 1 &&
    runEndCount === 1 &&
    (runEndReason === 'passed' || runEndReason === 'failed') &&
    runEndUnhandledCount === 0 &&
    finalUnhandledCount === 0 &&
    closeCallbackCount === 1 &&
    cachedCloseObserved &&
    frameworkClosed &&
    !closeFailed &&
    !timedOut
  const record = {
    schema: 'metis-qa-owner-framework-evidence/v1',
    sourceHead,
    runId: process.env.GITHUB_RUN_ID ?? '',
    runAttempt,
    target: process.env.QA_OWNER_TARGET ?? '',
    node: process.version,
    reporterSha256,
    runEndObserved: runEndCount === 1,
    runEndReason,
    runEndUnhandledCount,
    finalUnhandledCount,
    frameworkClosed: closeCallbackCount === 1 && cachedCloseObserved && frameworkClosed && !closeFailed,
    timedOut,
    complete
  }
  if (!outputPath) return
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`)
  if (bytes.byteLength < 1 || bytes.byteLength > 16 * 1024) return
  let fd = null
  try {
    fd = openSync(`${outputPath}.pending`, 'wx', 0o600)
    if (writeSync(fd, bytes, 0, bytes.byteLength, 0) !== bytes.byteLength) return
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(`${outputPath}.pending`, outputPath)
  } catch {
    // The collector refuses missing or incomplete reporter evidence.
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // The pending file remains invalid evidence.
      }
    }
  }
}

process.on('exit', publishAtExit)

export default class PersistenceOwnerDiagnosticReporter {
  onInit(ctx) {
    initCount += 1
    context = ctx
    ctx.onClose(() => {
      closeCallbackCount += 1
      queueMicrotask(() => {
        try {
          const closing = ctx.closingPromise
          if (!closing || typeof closing.then !== 'function') return
          cachedCloseObserved = true
          closing.then(
            () => {
              frameworkClosed = true
            },
            () => {
              closeFailed = true
            }
          )
        } catch {
          closeFailed = true
        }
      })
    })
  }

  onTestRunEnd(_modules, unhandledErrors, reason) {
    runEndCount += 1
    runEndReason = ['passed', 'failed', 'interrupted'].includes(reason) ? reason : null
    runEndUnhandledCount = safeCount(unhandledErrors)
  }

  onProcessTimeout() {
    timedOut = true
  }
}
