import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const MAX_REPORTED_ERRORS = 64
const MAX_FIELD_LENGTH = 128
const MAX_REPORT_BYTES = 32 * 1024

function boundedString(value) {
  return typeof value === 'string' ? value.slice(0, MAX_FIELD_LENGTH) : null
}

export default class RendererKatexUnhandledReporter {
  async onTestRunEnd(testModules, unhandledErrors) {
    const reportPath = process.env.RENDERER_KATEX_UNHANDLED_REPORT
    if (!reportPath) throw new Error('renderer-katex-unhandled-reporter:REPORT_PATH_MISSING')

    const errors = Array.from(unhandledErrors || [])
    const report = {
      schema: 1,
      runId: process.env.GITHUB_RUN_ID || null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
      job: process.env.GITHUB_JOB || null,
      runnerOs: process.env.RUNNER_OS || process.platform,
      fileCount: Array.isArray(testModules) ? testModules.length : -1,
      errorCount: errors.length,
      errors: errors.slice(0, MAX_REPORTED_ERRORS).map((error) => ({
        code: boundedString(error?.code),
        name: boundedString(error?.name)
      })),
      omittedErrors: Math.max(0, errors.length - MAX_REPORTED_ERRORS)
    }
    const output = `${JSON.stringify(report, null, 2)}\n`
    if (Buffer.byteLength(output, 'utf8') > MAX_REPORT_BYTES)
      throw new Error('renderer-katex-unhandled-reporter:REPORT_SIZE')
    writeFileSync(resolve(reportPath), output, { flag: 'wx' })
  }
}
