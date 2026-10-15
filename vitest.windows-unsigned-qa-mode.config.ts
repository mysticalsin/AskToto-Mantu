import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHermeticSandbox, hermeticEnv } from './scripts/hermetic/sandbox-env.mjs'
import { defineConfig } from 'vitest/config'
import type { Reporter, TestCase, TestModule } from 'vitest/node'

const CASE_REPORT = process.env.QA_U0_CASE_REPORT
const JSON_REPORT = process.env.QA_U0_VITEST_JSON
const sandbox = createHermeticSandbox()

function writeExclusive(path: string, value: unknown, maxBytes: number): void {
  if (!path) throw new Error('missing-U0-report-path')
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`)
  if (bytes.length < 2 || bytes.length > maxBytes) throw new Error('U0-report-bound')
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const fd = openSync(path, 'wx', 0o600)
  try {
    if (writeSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) throw new Error('U0-report-short-write')
  } finally {
    closeSync(fd)
  }
}

function suiteCount(module: TestModule): number {
  let count = 1 // The module itself is the outer recursive suite.
  const visit = (node: any): void => {
    for (let index = 0; index < node.children.size; index += 1) {
      const child = node.children.at(index)
      if (child.type === 'suite') {
        count += 1
        visit(child)
      }
    }
  }
  visit(module)
  return count
}

class WindowsUnsignedQaCaseReporter implements Reporter {
  private readonly tests: Record<string, unknown>[] = []
  private suiteCount = 0
  private moduleId: string | null = null
  private unhandledCount: number | null = null
  private runReason: string | null = null

  onTestCaseResult(testCase: TestCase): void {
    const diagnostic = testCase.diagnostic()
    const meta = testCase.meta()
    const record = meta.qaU0Record
    const errors = testCase.result().errors ?? []
    const errorKinds = errors.map((error) => (error.name === 'AssertionError' ? 'AssertionError' : 'non-assertion'))
    const row = {
      moduleId: testCase.module.moduleId.replaceAll('\\', '/'),
      fullName: testCase.fullName,
      state: testCase.result().state,
      retryCount: diagnostic?.retryCount ?? null,
      repeatCount: diagnostic?.repeatCount ?? null,
      errorKinds,
      case: record ?? null
    }
    const bytes = Buffer.byteLength(JSON.stringify(row))
    const total = this.tests.reduce((sum, prior) => sum + Buffer.byteLength(JSON.stringify(prior)), bytes)
    if (this.tests.length >= 50 || bytes > 4096 || total > 256 * 1024) throw new Error('U0-case-evidence-bound')
    this.tests.push(row)
  }

  onTestRunEnd(modules: ReadonlyArray<TestModule>, unhandledErrors: ReadonlyArray<unknown>, reason: string): void {
    this.unhandledCount = unhandledErrors.length
    this.runReason = reason
    if (modules.length !== 1) throw new Error('U0-module-count')
    this.moduleId = modules[0].moduleId.replaceAll('\\', '/')
    this.suiteCount = suiteCount(modules[0])
    const result = {
      schema: 'metis-windows-unsigned-qa-vitest-cases/v1',
      sourceHead: process.env.GITHUB_SHA ?? '',
      runId: process.env.GITHUB_RUN_ID ?? '',
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? '',
      target: process.env.QA_U0_TARGET ?? '',
      node: process.version,
      moduleId: this.moduleId,
      suiteCount: this.suiteCount,
      unhandledCount: this.unhandledCount,
      runReason: this.runReason,
      tests: this.tests
    }
    writeExclusive(CASE_REPORT ?? '', result, 256 * 1024)
  }
}

export default defineConfig({
  test: {
    include: ['scripts/qa/windows-unsigned-qa-mode.test.ts'],
    environment: 'node',
    env: hermeticEnv(sandbox),
    maxWorkers: 1,
    maxConcurrency: 1,
    fileParallelism: false,
    isolate: true,
    retry: 0,
    repeats: 0,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: [
      'default',
      'json',
      new WindowsUnsignedQaCaseReporter(),
      './scripts/qa/fixtures/persistence-owner-diagnostic-reporter.mjs'
    ],
    outputFile: { json: JSON_REPORT ?? '' }
  }
})
