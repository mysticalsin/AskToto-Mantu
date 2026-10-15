import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const MAX_REPORTED_ERRORS = 64
const MAX_FIELD_LENGTH = 128
const MAX_REPORT_BYTES = 32 * 1024

function boundedString(value) {
  return typeof value === 'string' ? value.slice(0, MAX_FIELD_LENGTH) : null
}

export default class SpeechOwnedTransferUnhandledReporter {
  async onTestRunEnd(testModules, unhandledErrors) {
    const reportPath = process.env.SPEECH_TRANSFER_UNHANDLED_REPORT
    if (!reportPath) throw new Error('speech-owned-transfer-unhandled-reporter:REPORT_PATH_MISSING')

    const errors = Array.from(unhandledErrors || [])
    // Vitest 4.1.11's JSON reporter omits retries and repeats. Its reporter task API exposes
    // the actual per-case diagnostic, including zero values, after the run has finished.
    const modules = Array.isArray(testModules) ? testModules : []
    const cases = modules.flatMap((module) =>
      [...module.children.allTests()].map((test) => {
        const diagnostic = test.diagnostic()
        return {
          file: module.relativeModuleId,
          fullName: `${test.parent.name} ${test.name}`,
          parentType: test.parent.type,
          state: test.result().state,
          retryCount: diagnostic?.retryCount ?? null,
          repeatCount: diagnostic?.repeatCount ?? null
        }
      })
    )
    const suites = modules.flatMap((module) => [
      { file: module.relativeModuleId, name: module.relativeModuleId, type: 'module' },
      ...[...module.children.allSuites()].map((suite) => ({
        file: module.relativeModuleId,
        name: suite.name,
        type: 'suite'
      }))
    ])
    const report = {
      schema: 2,
      runId: process.env.GITHUB_RUN_ID || null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
      job: process.env.GITHUB_JOB || null,
      runnerOs: process.env.RUNNER_OS || process.platform,
      platform: process.platform,
      architecture: process.arch,
      fileCount: modules.length,
      cases,
      suites,
      errorCount: errors.length,
      errors: errors.slice(0, MAX_REPORTED_ERRORS).map((error) => ({
        code: boundedString(error?.code),
        name: boundedString(error?.name),
        message: boundedString(error?.message)
      })),
      omittedErrors: Math.max(0, errors.length - MAX_REPORTED_ERRORS)
    }
    const output = `${JSON.stringify(report, null, 2)}\n`
    if (Buffer.byteLength(output, 'utf8') > MAX_REPORT_BYTES)
      throw new Error('speech-owned-transfer-unhandled-reporter:REPORT_SIZE')
    writeFileSync(resolve(reportPath), output, { flag: 'wx' })
  }
}
