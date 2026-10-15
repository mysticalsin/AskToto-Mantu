import { writeFileSync } from 'node:fs'

const integer = (value) => Number.isSafeInteger(value) && value >= 0

export default class PersistenceSettlementUnhandledReporter {
  finished = false

  onTestRunEnd(_testModules, unhandledErrors) {
    if (this.finished) throw new Error('persistence settlement unhandled evidence was emitted more than once')
    this.finished = true

    const outputPath = process.env.UNHANDLED_REPORT_PATH
    const sourceHead = process.env.GITHUB_SHA
    const runId = process.env.GITHUB_RUN_ID
    const runAttempt = process.env.GITHUB_RUN_ATTEMPT
    const job = process.env.GITHUB_JOB
    const target = process.env.PERSISTENCE_SETTLEMENT_TARGET
    const recordedAtMs = Date.now()
    if (
      !outputPath ||
      outputPath.length > 4096 ||
      typeof sourceHead !== 'string' ||
      !/^[a-f0-9]{40}$/.test(sourceHead) ||
      typeof runId !== 'string' ||
      !/^\d{1,20}$/.test(runId) ||
      typeof runAttempt !== 'string' ||
      !/^\d{1,6}$/.test(runAttempt) ||
      job !== 'test-first' ||
      target !== 'ubuntu-latest' ||
      !integer(recordedAtMs)
    ) {
      throw new Error('persistence settlement unhandled evidence bindings are invalid')
    }

    const inputKind = Array.isArray(unhandledErrors) ? 'array' : 'invalid'
    const unhandledCount = inputKind === 'array' ? unhandledErrors.length : null
    const evidence = {
      schema: 'metis-persistence-settlement-unhandled/v1',
      sourceHead,
      runId,
      runAttempt,
      job,
      target,
      observed: true,
      inputKind,
      unhandledCount,
      recordedAtMs
    }
    const bytes = `${JSON.stringify(evidence)}\n`
    if (Buffer.byteLength(bytes, 'utf8') > 4096) {
      throw new Error('persistence settlement unhandled evidence exceeded its bound')
    }
    try {
      writeFileSync(outputPath, bytes, { flag: 'wx', mode: 0o600 })
    } catch {
      throw new Error('persistence settlement unhandled evidence could not be retained')
    }
  }
}
