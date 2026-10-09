import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO = join(__dirname, '..')
const CHECKER = join(REPO, 'scripts', 'check-skipped-tests.mjs')
const hostedCi = process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true'
const BASELINE: Record<string, number> = { win32: 35, darwin: 3, linux: hostedCi ? 28 : 29 }
const allowed = BASELINE[process.platform]
if (allowed === undefined) throw new Error(`No synthetic skip baseline for ${process.platform}`)

type Assertion = { status: string; title: string }
type TestResult = {
  name: string
  status: string
  assertionResults: Assertion[]
}
type VitestReport = {
  success: boolean
  numTotalTestSuites: number
  numPassedTestSuites: number
  numFailedTestSuites: number
  numPendingTestSuites: number
  numTotalTests: number
  numPassedTests: number
  numFailedTests: number
  numPendingTests: number
  numTodoTests: number
  testResults: TestResult[]
}
type Fixture = { root: string; checker: string; fallback: string; sentinel: string }
type RunResult = { code: number; output: string }
type SummaryCase = [string, number]
type IncompleteCase = [string, (report: Record<string, unknown>) => void]

const invalidSummaryCases: SummaryCase[] = [
  ['negative', -1],
  ['fractional', 0.5]
]

const incompleteCases: IncompleteCase[] = [
  [
    'missing testResults',
    (report) => {
      delete report.testResults
    }
  ],
  [
    'nonarray testResults',
    (report) => {
      report.testResults = {}
    }
  ],
  [
    'empty testResults',
    (report) => {
      report.testResults = []
    }
  ],
  [
    'missing assertionResults',
    (report) => {
      delete (report.testResults as Array<Record<string, unknown>>)[0].assertionResults
    }
  ],
  [
    'nonarray assertionResults',
    (report) => {
      ;(report.testResults as Array<Record<string, unknown>>)[0].assertionResults = {}
    }
  ]
]

const nativeCanarySkipCases: Array<[string, boolean]> = [
  ['verifies selected bytes, CRC failure and policy rejection without extracting files', true],
  ['verifies selected bytes, CRC failure and policy rejection without extracting files extra', false]
]

function successfulReport(): VitestReport {
  const assertionResults: Assertion[] = [
    { status: 'passed', title: 'a completed root test' },
    ...Array.from({ length: allowed }, (_, index) => ({ status: 'pending', title: `declared skip ${index + 1}` })),
    { status: 'todo', title: 'TODO remains outside the existing skip baseline' }
  ]
  return {
    success: true,
    numTotalTestSuites: 1,
    numPassedTestSuites: 1,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    numTotalTests: assertionResults.length,
    numPassedTests: 1,
    numFailedTests: 0,
    numPendingTests: allowed,
    numTodoTests: 1,
    testResults: [{ name: '/synthetic/__fixtures__/dustcli.test.ts', status: 'passed', assertionResults }]
  }
}

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'metis-skips-report-'))
  const scripts = join(root, 'scripts')
  const nodeModules = join(root, 'node_modules', 'vitest')
  mkdirSync(scripts, { recursive: true })
  mkdirSync(nodeModules, { recursive: true })

  const checker = join(scripts, 'check-skipped-tests.mjs')
  const fallback = join(nodeModules, 'vitest.mjs')
  const sentinel = join(root, 'fallback-invoked')
  copyFileSync(CHECKER, checker)
  writeFileSync(
    fallback,
    [
      "import { mkdirSync, writeFileSync } from 'node:fs'",
      "import { dirname } from 'node:path'",
      `const report = ${JSON.stringify(successfulReport())}`,
      "const outputFile = process.argv.find((arg) => arg.startsWith('--outputFile='))?.slice('--outputFile='.length)",
      'const sentinel = process.env.METIS_SKIP_AUDIT_FALLBACK_SENTINEL',
      'if (!outputFile || !sentinel) process.exit(2)',
      'mkdirSync(dirname(outputFile), { recursive: true })',
      "writeFileSync(sentinel, 'fallback invoked\\n')",
      'writeFileSync(outputFile, JSON.stringify(report))'
    ].join('\n')
  )

  return { root, checker, fallback, sentinel }
}

function run(fixture: Fixture, args: string[]): RunResult {
  try {
    return {
      code: 0,
      output: execFileSync(process.execPath, [fixture.checker, ...args], {
        cwd: fixture.root,
        env: { ...process.env, METIS_SKIP_AUDIT_FALLBACK_SENTINEL: fixture.sentinel },
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 5_000,
        maxBuffer: 1024 * 1024
      })
    }
  } catch (error) {
    const result = error as { status?: number | null; stdout?: string; stderr?: string }
    return {
      code: typeof result.status === 'number' ? result.status : 1,
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`
    }
  }
}

function expectExplicitFailure(fixture: Fixture, result: RunResult, label: string): void {
  expect(existsSync(fixture.checker), 'copied checker fixture').toBe(true)
  expect(existsSync(fixture.fallback), 'fake fallback fixture').toBe(true)
  expect(result.code, result.output).toBe(1)
  expect(result.output).toContain(label)
  expect(existsSync(fixture.sentinel), result.output).toBe(false)
}

describe('MQA-252 explicit root-report handoff', () => {
  it.each(nativeCanarySkipCases)('requires the exact native canary skip title: %s', (title, accepted) => {
    const fixture = createFixture()
    try {
      const report = successfulReport()
      report.testResults[0].assertionResults.splice(1, 1)
      report.testResults.push({
        name: '/synthetic/__fixtures__/qa/retained-profile-analysis.test.ts',
        status: 'passed',
        assertionResults: [{ status: 'pending', title }]
      })
      report.numTotalTestSuites += 1
      report.numPassedTestSuites += 1
      const reportPath = join(fixture.root, 'native-canary.json')
      writeFileSync(reportPath, JSON.stringify(report))
      const result = run(fixture, [reportPath])
      if (accepted) {
        expect(result.code, result.output).toBe(0)
        expect(result.output).toContain('Runs the real Linux system unzip')
        expect(existsSync(fixture.sentinel)).toBe(false)
      } else {
        expectExplicitFailure(fixture, result, 'no declared reason for:')
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it.each([-1, 1])('rejects a declared skip count differing by %s without slack', (difference) => {
    const fixture = createFixture()
    try {
      const report = successfulReport()
      if (difference > 0) {
        report.testResults[0].assertionResults.push({ status: 'pending', title: 'extra declared skip' })
      } else {
        report.testResults[0].assertionResults.splice(1, 1)
      }
      report.numPendingTests += difference
      report.numTotalTests += difference
      const reportPath = join(fixture.root, 'skip-count.json')
      writeFileSync(reportPath, JSON.stringify(report))
      expectExplicitFailure(
        fixture,
        run(fixture, [reportPath]),
        difference > 0 ? 'above the declared baseline' : 'BELOW the baseline'
      )
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('accepts complete successful supplied evidence without starting fallback Vitest', () => {
    const fixture = createFixture()
    try {
      const report = join(fixture.root, 'root-report.json')
      writeFileSync(report, JSON.stringify(successfulReport()))

      const result = run(fixture, [report])

      expect(result.code, result.output).toBe(0)
      expect(result.output).toContain('[check:skips] OK')
      expect(existsSync(fixture.sentinel), result.output).toBe(false)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects an explicit missing report without starting fallback Vitest', () => {
    const fixture = createFixture()
    try {
      expectExplicitFailure(fixture, run(fixture, [join(fixture.root, 'missing.json')]), '[report:missing]')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects an explicit empty report path without starting fallback Vitest', () => {
    const fixture = createFixture()
    try {
      expectExplicitFailure(fixture, run(fixture, ['']), '[report:missing]')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects an explicit nonregular report without starting fallback Vitest', () => {
    const fixture = createFixture()
    try {
      const report = join(fixture.root, 'not-a-file')
      mkdirSync(report)
      expectExplicitFailure(fixture, run(fixture, [report]), '[report:not-file]')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects malformed explicit JSON without starting fallback Vitest', () => {
    const fixture = createFixture()
    try {
      const report = join(fixture.root, 'malformed.json')
      writeFileSync(report, '{')
      expectExplicitFailure(fixture, run(fixture, [report]), '[report:malformed]')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects failed explicit evidence without starting fallback Vitest', () => {
    const fixture = createFixture()
    try {
      const report = successfulReport()
      report.success = false
      const reportPath = join(fixture.root, 'failed.json')
      writeFileSync(reportPath, JSON.stringify(report))
      expectExplicitFailure(fixture, run(fixture, [reportPath]), '[report:failed]')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects incomplete explicit evidence without starting fallback Vitest', () => {
    const fixture = createFixture()
    try {
      const report = successfulReport()
      report.testResults[0].assertionResults.pop()
      const reportPath = join(fixture.root, 'incomplete.json')
      writeFileSync(reportPath, JSON.stringify(report))
      expectExplicitFailure(fixture, run(fixture, [reportPath]), '[report:incomplete]')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects an explicit report with a missing summary count without starting fallback Vitest', () => {
    const fixture = createFixture()
    try {
      const report = successfulReport() as unknown as Record<string, unknown>
      delete report.numTotalTests
      const reportPath = join(fixture.root, 'missing-summary.json')
      writeFileSync(reportPath, JSON.stringify(report))
      expectExplicitFailure(fixture, run(fixture, [reportPath]), '[report:invalid]')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it.each(
    invalidSummaryCases
  )('rejects a %s explicit summary count without starting fallback Vitest', (_kind, value) => {
    const fixture = createFixture()
    try {
      const report = successfulReport()
      report.numPassedTests = value
      const reportPath = join(fixture.root, 'invalid-summary.json')
      writeFileSync(reportPath, JSON.stringify(report))
      expectExplicitFailure(fixture, run(fixture, [reportPath]), '[report:invalid]')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects a nonfinite explicit summary count without starting fallback Vitest', () => {
    const fixture = createFixture()
    try {
      const report = JSON.stringify(successfulReport()).replace('"numPassedTests":1', '"numPassedTests":1e999')
      const reportPath = join(fixture.root, 'nonfinite-summary.json')
      writeFileSync(reportPath, report)
      expectExplicitFailure(fixture, run(fixture, [reportPath]), '[report:invalid]')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects a failed count even when success is true without starting fallback Vitest', () => {
    const fixture = createFixture()
    try {
      const report = successfulReport()
      report.numPassedTests = 0
      report.numFailedTests = 1
      const reportPath = join(fixture.root, 'failed-count.json')
      writeFileSync(reportPath, JSON.stringify(report))
      expectExplicitFailure(fixture, run(fixture, [reportPath]), '[report:failed]')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it.each(incompleteCases)('rejects %s without starting fallback Vitest', (_kind, mutate) => {
    const fixture = createFixture()
    try {
      const report = successfulReport() as unknown as Record<string, unknown>
      mutate(report)
      const reportPath = join(fixture.root, 'incomplete.json')
      writeFileSync(reportPath, JSON.stringify(report))
      expectExplicitFailure(fixture, run(fixture, [reportPath]), '[report:incomplete]')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects inconsistent assertion totals without starting fallback Vitest', () => {
    const fixture = createFixture()
    try {
      const report = successfulReport()
      report.numTotalTests += 1
      const reportPath = join(fixture.root, 'inconsistent-total.json')
      writeFileSync(reportPath, JSON.stringify(report))
      expectExplicitFailure(fixture, run(fixture, [reportPath]), '[report:incomplete]')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects zero or inconsistent suite totals without starting fallback Vitest', () => {
    const fixture = createFixture()
    try {
      const zeroSuites = successfulReport()
      zeroSuites.numTotalTestSuites = 0
      const zeroPath = join(fixture.root, 'zero-suites.json')
      writeFileSync(zeroPath, JSON.stringify(zeroSuites))
      expectExplicitFailure(fixture, run(fixture, [zeroPath]), '[report:incomplete]')

      const inconsistentSuites = successfulReport()
      inconsistentSuites.numPassedTestSuites = 0
      const inconsistentPath = join(fixture.root, 'inconsistent-suites.json')
      writeFileSync(inconsistentPath, JSON.stringify(inconsistentSuites))
      expectExplicitFailure(fixture, run(fixture, [inconsistentPath]), '[report:incomplete]')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects unknown assertion statuses without starting fallback Vitest', () => {
    const fixture = createFixture()
    try {
      const report = successfulReport()
      report.testResults[0].assertionResults[0].status = 'unknown'
      const reportPath = join(fixture.root, 'unknown-status.json')
      writeFileSync(reportPath, JSON.stringify(report))
      expectExplicitFailure(fixture, run(fixture, [reportPath]), '[report:invalid]')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects unknown file statuses without starting fallback Vitest', () => {
    const fixture = createFixture()
    try {
      const report = successfulReport()
      report.testResults[0].status = 'queued'
      const reportPath = join(fixture.root, 'unknown-file-status.json')
      writeFileSync(reportPath, JSON.stringify(report))
      expectExplicitFailure(fixture, run(fixture, [reportPath]), '[report:invalid]')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects extra explicit arguments without starting fallback Vitest', () => {
    const fixture = createFixture()
    try {
      const report = join(fixture.root, 'root-report.json')
      writeFileSync(report, JSON.stringify(successfulReport()))
      expectExplicitFailure(fixture, run(fixture, [report, 'unexpected']), '[report:arguments]')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('keeps the documented no-argument fallback for standalone use', () => {
    const fixture = createFixture()
    try {
      const result = run(fixture, [])

      expect(result.code, result.output).toBe(0)
      expect(readFileSync(fixture.sentinel, 'utf8')).toBe('fallback invoked\n')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })
})
