import * as fs from 'node:fs'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { diagnoseRootReport, MAX_REPORT_BYTES } from './root-report-diagnostic.mjs'

const root = join(__dirname, '..', '..')
const workflow = readFileSync(join(root, '.github', 'workflows', 'build.yml'), 'utf8').replace(/\r\n/g, '\n')
const project = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }

function expectOutcomeEnvironmentBindings(producer: string): void {
  expect(producer).toMatch(
    /pipelineOutcome:\s*env\.METIS_CI_PIPELINE_OUTCOME\s*,\s*auditOutcome:\s*env\.METIS_CI_AUDIT_OUTCOME/
  )
}

describe('actual diagnostic outcome environment bindings', () => {
  it('accepts the real producer across formatter whitespace', () => {
    const producer = readFileSync(join(root, 'scripts', 'ci', 'root-report-diagnostic.mjs'), 'utf8')
    expectOutcomeEnvironmentBindings(producer)
  })

  it.each([
    ['METIS_CI_PIPELINE_OUTCOME', 'METIS_CI_AUDIT_OUTCOME'],
    ['METIS_CI_AUDIT_OUTCOME', 'METIS_CI_PIPELINE_OUTCOME']
  ])('rejects substituting the actual %s binding with %s', (before, after) => {
    const producer = readFileSync(join(root, 'scripts', 'ci', 'root-report-diagnostic.mjs'), 'utf8')
    expectOutcomeEnvironmentBindings(producer)
    expect(producer.split(before)).toHaveLength(2)
    expect(() => expectOutcomeEnvironmentBindings(producer.replace(before, after))).toThrow()
  })
})

function qualityJob(source = workflow): string {
  const lines = source.split('\n')
  const header = '  quality:'
  expect(
    lines.filter((line) => line === header),
    'one quality job'
  ).toHaveLength(1)
  const start = lines.indexOf(header)
  const end = lines.findIndex((line, index) => index > start && /^ {2}[A-Za-z0-9_-]+:/.test(line))
  return lines.slice(start, end === -1 ? undefined : end).join('\n')
}

function namedStep(job: string, name: string): string {
  const lines = job.split('\n')
  const header = `      - name: ${name}`
  expect(
    lines.filter((line) => line === header),
    `one ${name} step`
  ).toHaveLength(1)
  const start = lines.indexOf(header)
  const end = lines.findIndex((line, index) => index > start && /^ {6}- /.test(line))
  return lines.slice(start, end === -1 ? undefined : end).join('\n')
}

describe('cross-platform quality matrix and post-root Linux architecture gates', () => {
  it('runs quality on Ubuntu, Windows and macOS', () => {
    const job = qualityJob()
    expect(job).toContain('        os: [ubuntu-latest, windows-latest, macos-latest]\n')
  })

  it('retains the root report before running blocking Linux architecture checks', () => {
    const job = qualityJob()
    const retention = namedStep(job, 'Retain original root test report')
    const layering = namedStep(job, 'Architecture layering')
    const ratchet = namedStep(job, 'Architecture ratchet')
    const colors = '      - run: npm run check:colors'
    for (const [step, command] of [
      [layering, 'npm run check:layering'],
      [ratchet, 'npm run check:architecture']
    ] as const) {
      expect(step).toContain("        if: ${{ !cancelled() && runner.os == 'Linux' }}\n")
      expect(step).toContain(`        run: ${command}\n`)
      expect(step).not.toContain('continue-on-error')
    }
    expect(job.indexOf(namedStep(job, 'Run complete test pipeline'))).toBeLessThan(job.indexOf(retention))
    expect(job.indexOf(namedStep(job, 'Audit declared skips from root report'))).toBeLessThan(job.indexOf(retention))
    expect(job.indexOf(namedStep(job, 'Log bounded root report diagnostic'))).toBeLessThan(job.indexOf(retention))
    expect(job.indexOf(retention)).toBeLessThan(job.indexOf(layering))
    expect(job.indexOf(layering)).toBeLessThan(job.indexOf(ratchet))
    expect(job.indexOf(ratchet)).toBeLessThan(job.indexOf(colors))
    expect(job).not.toMatch(/continue-on-error:\s*true/)
  })
})

describe('root Vitest report handoff workflow', () => {
  it('keeps npm test as the sole mode-lock, root, proxy, and Operator pipeline', () => {
    expect(project.scripts.test).toBe(
      'node scripts/lock-mode-skills.mjs --check && vitest run && npm run test:proxy && npm run test:operator'
    )
  })

  it('uses the same fresh report path at runner-aware step scope for this matrix attempt', () => {
    const job = qualityJob()
    const test = namedStep(job, 'Run complete test pipeline')
    const audit = namedStep(job, 'Audit declared skips from root report')
    const diagnostic = namedStep(job, 'Log bounded root report diagnostic')
    const rootReportEnv =
      '        env:\n' +
      '          METIS_CI_ROOT_REPORT: ${{ runner.temp }}/metis-ci-root-report-' +
      '${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.os }}.json'
    expect(test).toContain(rootReportEnv)
    expect(audit).toContain(rootReportEnv)
    expect(diagnostic).toContain(rootReportEnv)
    expect(workflow.replace(test, '').replace(audit, '').replace(diagnostic, '')).not.toContain('METIS_CI_ROOT_REPORT')
  })

  it('clears only that report before the unchanged npm test chain and never masks failures', () => {
    const job = qualityJob()
    const test = namedStep(job, 'Run complete test pipeline')

    const cleanup = 'node -e "require(\'node:fs\').rmSync(process.env.METIS_CI_ROOT_REPORT, { force: true })"'
    expect(test).not.toMatch(/^\s+shell:/m)
    expect(test).toContain(`        run: |\n          ${cleanup} && npm test`)
    expect(test.match(/^ {10}.*\bnpm test\b/gm)).toHaveLength(1)
    expect(test).not.toMatch(/continue-on-error|\|\||npx\s+vitest|--reporter/)
    expect(job).not.toMatch(/continue-on-error:\s*true/)
  })

  it('passes the same fresh report explicitly to the later skip audit', () => {
    const job = qualityJob()
    const test = namedStep(job, 'Run complete test pipeline')
    const audit = namedStep(job, 'Audit declared skips from root report')

    expect(audit).not.toMatch(/^\s+shell:/m)
    expect(audit).toContain('        run: npm run check:skips -- "${{ env.METIS_CI_ROOT_REPORT }}"')
    expect(audit).not.toMatch(/continue-on-error|npx\s+vitest/)
    expect(audit.match(/^ {8}run: (.+)$/m)![1]).not.toContain('||')
    expect(job.indexOf(test)).toBeLessThan(job.indexOf(audit))
  })
})

function expectFailureAuditConnection(source: string): string {
  const job = qualityJob(source)
  const pipeline = namedStep(job, 'Run complete test pipeline')
  const audit = namedStep(job, 'Audit declared skips from root report')
  const gate =
    "!cancelled() && (steps.complete_tests.outcome == 'success' || steps.complete_tests.outcome == 'failure')"
  expect(audit).toContain(`        if: \${{ ${gate} }}\n`)
  expect(audit).toContain('        run: npm run check:skips -- "${{ env.METIS_CI_ROOT_REPORT }}"')
  expect(audit).not.toMatch(/continue-on-error|npx\s+vitest/)
  expect(pipeline).toContain(' && npm test')
  expect(pipeline.match(/^ {10}.*\bnpm test\b/gm)).toHaveLength(1)
  expect(pipeline).not.toMatch(/continue-on-error|\|\||npx\s+vitest/)
  const retention = namedStep(job, 'Retain original root test report')
  expect(job.replace(retention, '')).not.toMatch(/upload-artifact|GITHUB_OUTPUT|GITHUB_STEP_SUMMARY|base64/)
  expect(job.indexOf(pipeline)).toBeLessThan(job.indexOf(audit))
  return gate
}

describe('original strict skip audit after pipeline failure', () => {
  it('ignores explanatory npm test mentions outside executable shell lines', () => {
    const pipeline = namedStep(qualityJob(), 'Run complete test pipeline')
    const changed = workflow.replace(pipeline, `${pipeline}\n      # npm test is still the sole pipeline.\n`)
    expectFailureAuditConnection(changed)
  })

  it('rejects an actual additional npm test command', () => {
    const pipeline = namedStep(qualityJob(), 'Run complete test pipeline')
    const changed = pipeline.replace('&& npm test', '&& npm test\n          npm test')
    expect(() => expectFailureAuditConnection(workflow.replace(pipeline, changed))).toThrow()
  })

  it.each([
    { outcome: 'success', cancelled: false, allowed: true },
    { outcome: 'failure', cancelled: false, allowed: true },
    { outcome: 'skipped', cancelled: false, allowed: false },
    { outcome: 'cancelled', cancelled: false, allowed: false },
    { outcome: '', cancelled: false, allowed: false },
    { outcome: 'success', cancelled: true, allowed: false },
    { outcome: 'failure', cancelled: true, allowed: false },
    { outcome: 'skipped', cancelled: true, allowed: false },
    { outcome: 'cancelled', cancelled: true, allowed: false },
    { outcome: '', cancelled: true, allowed: false }
  ])('gates the original full-report audit for outcome=$outcome cancellation=$cancelled', ({
    outcome,
    cancelled,
    allowed
  }) => {
    const gate = expectFailureAuditConnection(workflow)
    // The asserted expression uses only the shared boolean/equality subset of Actions expressions.
    // Evaluate that actual workflow gate; this does not simulate or qualify an Actions runner.
    const audit = namedStep(qualityJob(), 'Audit declared skips from root report')
    const actual = audit.match(/^ {8}if: \$\{\{ (.+) \}\}$/m)![1]
    expect(actual).toBe(gate)
    const evaluate = new Function('cancelled', 'steps', `return (${actual})`) as (
      cancelled: () => boolean,
      steps: { complete_tests: { outcome: string } }
    ) => boolean
    expect(evaluate(() => cancelled, { complete_tests: { outcome } })).toBe(allowed)
  })

  it.each([
    ['success-only gate', 'if: success()'],
    ['missing gate', '# gate removed'],
    ['cancelled work admitted', 'if: ${{ always() }}']
  ])('rejects workflow regression: %s', (_label, replacement) => {
    expectFailureAuditConnection(workflow)
    const audit = namedStep(qualityJob(), 'Audit declared skips from root report')
    const changed = audit.replace(/^ {8}if: .+$/m, `        ${replacement}`)
    expect(() => expectFailureAuditConnection(workflow.replace(audit, changed))).toThrow()
  })
})

function expectRootArtifactConnection(source: string): string {
  const job = qualityJob(source)
  const retention = namedStep(job, 'Retain original root test report')
  const gate =
    "!cancelled() && (steps.complete_tests.outcome == 'success' || steps.complete_tests.outcome == 'failure')"
  expect(retention).toContain(`        if: \${{ ${gate} }}\n`)
  expect(retention).toContain(
    '        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2\n'
  )
  expect(retention.match(/^ {8}uses:/gm)).toHaveLength(1)
  expect(retention).toContain(
    '          name: metis-ci-root-report-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.os }}\n'
  )
  expect(retention).toContain(
    '          path: ${{ runner.temp }}/metis-ci-root-report-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.os }}.json\n'
  )
  expect(retention).toContain('          if-no-files-found: error\n')
  expect(retention).toContain('          retention-days: 1\n')
  expect(retention).toContain('          overwrite: false\n')
  expect(retention.match(/^ {10}[A-Za-z][A-Za-z0-9-]*:/gm)).toEqual([
    '          name:',
    '          path:',
    '          if-no-files-found:',
    '          retention-days:',
    '          overwrite:'
  ])
  expect(retention).not.toMatch(
    /^\s+(?:run|env|shell):|continue-on-error|secrets\.|GITHUB_OUTPUT|GITHUB_STEP_SUMMARY|base64/m
  )
  expect(job.indexOf(namedStep(job, 'Run complete test pipeline'))).toBeLessThan(job.indexOf(retention))
  expect(job.indexOf(namedStep(job, 'Audit declared skips from root report'))).toBeLessThan(job.indexOf(retention))
  expect(job.indexOf(namedStep(job, 'Log bounded root report diagnostic'))).toBeLessThan(job.indexOf(retention))
  expect(job.indexOf(retention)).toBeLessThan(job.indexOf('      - run: npm run check:colors'))
  return retention
}

describe('original full root report artifact retention', () => {
  it.each([
    { outcome: 'success', cancelled: false, allowed: true },
    { outcome: 'failure', cancelled: false, allowed: true },
    { outcome: 'skipped', cancelled: false, allowed: false },
    { outcome: 'cancelled', cancelled: false, allowed: false },
    { outcome: '', cancelled: false, allowed: false },
    { outcome: 'success', cancelled: true, allowed: false },
    { outcome: 'failure', cancelled: true, allowed: false },
    { outcome: 'skipped', cancelled: true, allowed: false },
    { outcome: 'cancelled', cancelled: true, allowed: false },
    { outcome: '', cancelled: true, allowed: false }
  ])('retains the original report for producer=$outcome cancellation=$cancelled', ({ outcome, cancelled, allowed }) => {
    const retention = expectRootArtifactConnection(workflow)
    const actual = retention.match(/^ {8}if: \$\{\{ (.+) \}\}$/m)![1]
    const evaluate = new Function('cancelled', 'steps', `return (${actual})`) as (
      cancelled: () => boolean,
      steps: { complete_tests: { outcome: string } }
    ) => boolean
    expect(evaluate(() => cancelled, { complete_tests: { outcome } })).toBe(allowed)
  })

  it.each([
    [
      'success-only upload',
      "if: ${{ !cancelled() && (steps.complete_tests.outcome == 'success' || steps.complete_tests.outcome == 'failure') }}",
      'if: success()'
    ],
    ['unpinned action', 'upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02', 'upload-artifact@v4'],
    [
      'foreign attempt',
      'path: ${{ runner.temp }}/metis-ci-root-report-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.os }}.json',
      'path: ${{ runner.temp }}/metis-ci-root-report-${{ github.run_id }}-999-${{ matrix.os }}.json'
    ],
    [
      'broad upload',
      'path: ${{ runner.temp }}/metis-ci-root-report-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.os }}.json',
      'path: ${{ runner.temp }}/**'
    ],
    ['hidden extra path', '          path:', '          path: ${{ github.workspace }}/private\n          path:'],
    ['missing report ignored', 'if-no-files-found: error', 'if-no-files-found: ignore'],
    ['longer retention', 'retention-days: 1', 'retention-days: 14'],
    ['overwrite permitted', 'overwrite: false', 'overwrite: true'],
    ['failure masked', '        with:', '        continue-on-error: true\n        with:'],
    ['raw report printing', '        with:', '        run: cat report.json\n        with:'],
    ['extra credential', '        with:', '        env:\n          TOKEN: ${{ secrets.EXTRA_TOKEN }}\n        with:']
  ])('rejects retention regression: %s', (_label, before, after) => {
    const retention = expectRootArtifactConnection(workflow)
    expect(retention.split(before)).toHaveLength(2)
    expect(() => expectRootArtifactConnection(workflow.replace(retention, retention.replace(before, after)))).toThrow()
  })

  it('uses the existing root reporter and isolated fixture home without introducing quality-job secrets', () => {
    expectRootArtifactConnection(workflow)
    expect(qualityJob()).not.toContain('secrets.')
  })
})

function expectDiagnosticConnection(source: string): void {
  const job = qualityJob(source)
  const pipeline = namedStep(job, 'Run complete test pipeline')
  const audit = namedStep(job, 'Audit declared skips from root report')
  const diagnostic = namedStep(job, 'Log bounded root report diagnostic')
  expect(pipeline).toContain('        id: complete_tests\n')
  expect(audit).toContain('        id: declared_skips\n')
  expect(diagnostic).toContain('        if: ${{ always() }}\n')
  expect(diagnostic).toContain('        run: node scripts/ci/root-report-diagnostic.mjs')
  expect(diagnostic).toContain(
    '          METIS_CI_ROOT_REPORT: ${{ runner.temp }}/metis-ci-root-report-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.os }}.json\n'
  )
  for (const line of [
    'METIS_CI_RUNNER_TEMP: ${{ runner.temp }}',
    'METIS_CI_WORKSPACE: ${{ github.workspace }}',
    'METIS_CI_RUN_ID: ${{ github.run_id }}',
    'METIS_CI_RUN_ATTEMPT: ${{ github.run_attempt }}',
    'METIS_CI_MATRIX_OS: ${{ matrix.os }}',
    'METIS_CI_PIPELINE_OUTCOME: ${{ steps.complete_tests.outcome }}',
    'METIS_CI_AUDIT_OUTCOME: ${{ steps.declared_skips.outcome }}'
  ])
    expect(diagnostic).toContain(`          ${line}\n`)
  expect(diagnostic.match(/^ {8}run:/gm)).toHaveLength(1)
  expect(diagnostic).not.toMatch(
    /continue-on-error|\|\||npx\s+vitest|upload-artifact|GITHUB_OUTPUT|GITHUB_STEP_SUMMARY/
  )
  expect(job).not.toMatch(/continue-on-error:\s*true/)
  expect(job.indexOf(pipeline)).toBeLessThan(job.indexOf(audit))
  expect(job.indexOf(audit)).toBeLessThan(job.indexOf(diagnostic))
  expect(job.indexOf(diagnostic)).toBeLessThan(job.indexOf('      - run: npm run check:colors'))
}

describe('bounded root report diagnostic workflow connection', () => {
  it('always reads only the existing attempt after the unchanged pipeline and audit', () => {
    expectDiagnosticConnection(workflow)
  })

  it.each([
    ['success-only diagnostic', '        if: ${{ always() }}', '        if: success()'],
    ['foreign attempt context', 'METIS_CI_RUN_ATTEMPT: ${{ github.run_attempt }}', 'METIS_CI_RUN_ATTEMPT: 999'],
    [
      'foreign report attempt',
      'metis-ci-root-report-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.os }}.json',
      'metis-ci-root-report-${{ github.run_id }}-999-${{ matrix.os }}.json'
    ],
    ['wrong pipeline outcome', 'steps.complete_tests.outcome', 'steps.declared_skips.outcome'],
    ['wrong audit outcome', 'steps.declared_skips.outcome', 'steps.complete_tests.outcome'],
    [
      'masked diagnostic',
      '        run: node scripts/ci/root-report-diagnostic.mjs',
      '        run: node scripts/ci/root-report-diagnostic.mjs || true'
    ],
    ['new test fallback', '        run: node scripts/ci/root-report-diagnostic.mjs', '        run: npx vitest run'],
    [
      'artifact upload',
      '        run: node scripts/ci/root-report-diagnostic.mjs',
      '        uses: actions/upload-artifact@fixture'
    ],
    [
      'continue on error',
      '        run: node scripts/ci/root-report-diagnostic.mjs',
      '        continue-on-error: true\n        run: node scripts/ci/root-report-diagnostic.mjs'
    ]
  ])('rejects a single workflow mutation: %s', (_label, before, after) => {
    const diagnostic = namedStep(qualityJob(), 'Log bounded root report diagnostic')
    expect(diagnostic.split(before)).toHaveLength(2)
    const changed = workflow.replace(diagnostic, diagnostic.replace(before, after))
    expect(() => expectDiagnosticConnection(changed)).toThrow()
  })

  it('rejects moving the diagnostic before its evidence producer', () => {
    const diagnostic = namedStep(qualityJob(), 'Log bounded root report diagnostic')
    const changed = workflow
      .replace(diagnostic, '')
      .replace('      - name: Run complete test pipeline', `${diagnostic}\n      - name: Run complete test pipeline`)
    expect(() => expectDiagnosticConnection(changed)).toThrow()
  })
})

const canary = 'PRIVATE_TRANSCRIPT ::warning:: /private/owner/session-secret'
// Synthetic report identities keep their exact runtime extension without naming repository sources.
const fixtureTsExtension = '.' + 'ts'
type Report = {
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
  testResults: Array<{
    name: string
    status: string
    message?: string
    assertionResults: Array<{
      status: string
      title: string
      fullName: string
      ancestorTitles: string[]
      failureMessages?: string[]
      meta?: unknown
    }>
  }>
}

function reportFixture(skips = 2): {
  folder: string
  context: Parameters<typeof diagnoseRootReport>[0]
  report: Report
} {
  const folder = mkdtempSync(join(tmpdir(), 'metis-root-diagnostic-'))
  const runnerTemp = join(folder, 'runner')
  const workspace = join(folder, 'workspace')
  mkdirSync(runnerTemp)
  mkdirSync(workspace)
  mkdirSync(join(workspace, 'src', 'main'), { recursive: true })
  writeFileSync(
    join(workspace, 'src', 'main', 'win-security.test' + fixtureTsExtension),
    '// test-owned source identity only\n'
  )
  const context = {
    ci: 'true',
    githubActions: 'true',
    runnerTemp,
    workspace,
    runId: '123',
    runAttempt: '2',
    matrixOs: 'windows-latest',
    reportPath: join(runnerTemp, 'metis-ci-root-report-123-2-windows-latest.json'),
    pipelineOutcome: 'success',
    auditOutcome: 'success'
  }
  const assertion = (status: string, title: string) => ({
    status,
    title,
    fullName: `outer ${title}`,
    ancestorTitles: ['outer']
  })
  const report: Report = {
    success: true,
    numTotalTestSuites: 3,
    numPassedTestSuites: 3,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    numTotalTests: skips + 2,
    numPassedTests: 1,
    numFailedTests: 0,
    numPendingTests: skips,
    numTodoTests: 1,
    testResults: [
      {
        name: join(workspace, 'src', 'main', 'win-security.test' + fixtureTsExtension),
        status: 'passed',
        assertionResults: [
          assertion('passed', 'completed'),
          ...Array.from({ length: skips }, (_, i) => assertion('skipped', `skip ${i}`)),
          assertion('todo', 'planned')
        ]
      }
    ]
  }
  return { folder, context, report }
}

function withReport(run: (fixture: ReturnType<typeof reportFixture>) => void, skips = 2): void {
  const fixture = reportFixture(skips)
  try {
    run(fixture)
  } finally {
    rmSync(fixture.folder, { recursive: true, force: true })
  }
}

function diagnose(
  fixture: ReturnType<typeof reportFixture>,
  io: Parameters<typeof diagnoseRootReport>[1] = fs
): ReturnType<typeof diagnoseRootReport> {
  writeFileSync(fixture.context.reportPath, JSON.stringify(fixture.report))
  return diagnoseRootReport(fixture.context, io)
}

function expectNotPass(result: ReturnType<typeof diagnoseRootReport>, reason: string): void {
  expect(result.exitCode).toBe(1)
  expect(JSON.stringify(result.summary)).toContain(reason)
  expect(result.summary.status).not.toBe('DIAGNOSTIC_COMPLETE')
  expect(JSON.stringify(result.summary)).not.toContain(canary)
}

describe('bounded root report diagnostic producer', () => {
  it.each(['ubuntu-latest', 'windows-latest', 'macos-latest'])(
    'accepts only the named hosted quality runner label: %s',
    (matrixOs) =>
      withReport((fixture) => {
        fixture.context.matrixOs = matrixOs
        fixture.context.reportPath = join(
          fixture.context.runnerTemp,
          `metis-ci-root-report-${fixture.context.runId}-${fixture.context.runAttempt}-${matrixOs}.json`
        )
        expect(diagnose(fixture).summary.status).toBe('DIAGNOSTIC_COMPLETE')
      })
  )

  it.each(['linux-latest', 'macos-15', 'self-hosted'])('rejects an untrusted runner label: %s', (matrixOs) =>
    withReport((fixture) => {
      fixture.context.matrixOs = matrixOs
      expectNotPass(diagnose(fixture), 'NOT_PASS_CONTEXT')
    })
  )

  it('keeps a coherent failed 38-skip inventory without claiming PASS or equating suites with files', () =>
    withReport((fixture) => {
      fixture.report.success = false
      fixture.report.numFailedTestSuites = 2
      fixture.report.numPassedTestSuites = 1
      fixture.report.testResults[0].status = 'failed'
      fixture.context.pipelineOutcome = 'failure'
      fixture.context.auditOutcome = 'skipped'
      const result = diagnose(fixture)
      expectNotPass(result, 'NOT_PASS_ROOT_FAILED')
      expect(result.summary.reasons).toEqual(['NOT_PASS_ROOT_FAILED', 'NOT_PASS_PIPELINE', 'NOT_PASS_AUDIT'])
      expect(result.summary.skips).toHaveLength(38)
      expect(result.summary.observed).toEqual({ files: 1, assertions: 40, skipped: 38, todo: 1 })
      expect(result.summary.skips?.every((skip) => /^[a-f0-9]{64}$/.test(skip.identitySha256))).toBe(true)
    }, 38))

  it('emits only bounded safe fields and deterministic full-identity digests, retaining duplicates', () =>
    withReport((fixture) => {
      const skipped = fixture.report.testResults[0].assertionResults[1]
      skipped.title = canary
      skipped.fullName = canary
      skipped.ancestorTitles = [canary]
      skipped.failureMessages = [canary]
      skipped.meta = { private: canary }
      fixture.report.testResults[0].message = canary
      const first = diagnose(fixture)
      expect(first.exitCode).toBe(0)
      expect(first.summary.status).toBe('DIAGNOSTIC_COMPLETE')
      const text = JSON.stringify(first.summary)
      expect(text).not.toContain(canary)
      expect(text).not.toContain(fixture.folder)
      expect(text).not.toContain('failureMessages')
      expect(text).not.toContain('title')
      expect(first.summary.skips?.[0].file).toBe('src/main/win-security.test' + fixtureTsExtension)
      expect(diagnose(fixture).summary).toEqual(first.summary)
      fixture.report.testResults[0].assertionResults.reverse()
      expect(diagnose(fixture).summary.inventorySha256).toBe(first.summary.inventorySha256)
      skipped.ancestorTitles = ['another scope']
      expect(diagnose(fixture).summary.inventorySha256).not.toBe(first.summary.inventorySha256)
      const secondSkip = fixture.report.testResults[0].assertionResults.findIndex(
        (entry) => entry.status === 'skipped' && entry !== skipped
      )
      fixture.report.testResults[0].assertionResults[secondSkip] = { ...skipped }
      const duplicate = diagnose(fixture).summary.skips
      expect(duplicate).toHaveLength(2)
      expect(duplicate?.map((skip) => skip.occurrence)).toEqual([1, 2])
    }))

  it.each(['failure', 'cancelled', 'skipped', ''])('does not mask a later pipeline outcome: %s', (outcome) =>
    withReport((fixture) => {
      fixture.context.pipelineOutcome = outcome
      expectNotPass(diagnose(fixture), 'NOT_PASS_PIPELINE')
    }))

  it.each(['failure', 'cancelled', 'skipped', ''])('does not qualify an unavailable/failed audit: %s', (outcome) =>
    withReport((fixture) => {
      fixture.context.auditOutcome = outcome
      expectNotPass(diagnose(fixture), 'NOT_PASS_AUDIT')
    }))

  it.each(['assertion', 'suite'])('does not confuse actual pending %s work with an intentional skip', (kind) =>
    withReport((fixture) => {
      if (kind === 'assertion') fixture.report.testResults[0].assertionResults[1].status = 'pending'
      else {
        fixture.report.numPassedTestSuites -= 1
        fixture.report.numPendingTestSuites += 1
      }
      const result = diagnose(fixture)
      expectNotPass(result, 'NOT_PASS_INCOMPLETE')
      expect(result.summary.skips).toHaveLength(2)
      if (kind === 'assertion') expect(result.summary.skips?.some((skip) => skip.status === 'pending')).toBe(true)
    }))

  it.each([
    [
      'negative count',
      (r: Report) => {
        r.numPassedTests = -1
      }
    ],
    [
      'fractional count',
      (r: Report) => {
        r.numTotalTests = 1.5
      }
    ],
    [
      'unsafe count',
      (r: Report) => {
        r.numTotalTests = Number.MAX_SAFE_INTEGER + 1
      }
    ],
    [
      'inconsistent total',
      (r: Report) => {
        r.numTotalTests += 1
      }
    ],
    [
      'inconsistent pending',
      (r: Report) => {
        r.numPendingTests -= 1
      }
    ],
    [
      'inconsistent suites',
      (r: Report) => {
        r.numPassedTestSuites += 1
      }
    ],
    [
      'empty files',
      (r: Report) => {
        r.testResults = []
      }
    ],
    [
      'unknown assertion status',
      (r: Report) => {
        r.testResults[0].assertionResults[0].status = canary
      }
    ],
    [
      'false successful result',
      (r: Report) => {
        r.testResults[0].status = 'failed'
      }
    ],
    [
      'invalid identity',
      (r: Report) => {
        r.testResults[0].assertionResults[1].ancestorTitles = null as never
      }
    ]
  ])('refuses malformed/incomplete evidence: %s', (_label, mutate) =>
    withReport((fixture) => {
      mutate(fixture.report)
      expectNotPass(diagnose(fixture), 'NOT_PASS_')
    }))

  it.each([
    'null',
    '{',
    '[]',
    JSON.stringify({ testResults: canary })
  ])('refuses corrupt or nonreport JSON without echo: %s', (text) =>
    withReport((fixture) => {
      writeFileSync(fixture.context.reportPath, text)
      expectNotPass(diagnoseRootReport(fixture.context), 'NOT_PASS_')
    }))

  it.each([
    'src/../private/session.test' + fixtureTsExtension,
    '/private/owner/session.test' + fixtureTsExtension,
    'src/main/::warning::.test' + fixtureTsExtension,
    'src/main/not-a-test' + fixtureTsExtension,
    'src/main/secret\nname.test.ts'
  ])('refuses unsafe/outside test identities: %s', (name) =>
    withReport((fixture) => {
      fixture.report.testResults[0].name = name
      const result = diagnose(fixture)
      expectNotPass(result, 'NOT_PASS_IDENTITY')
      expect(JSON.stringify(result.summary)).not.toContain(name)
    }))

  it('refuses duplicate or case-colliding file records', () =>
    withReport((fixture) => {
      fixture.report.testResults.push({
        ...fixture.report.testResults[0],
        name: fixture.report.testResults[0].name.replace('win-security', 'WIN-security')
      })
      expectNotPass(diagnose(fixture), 'NOT_PASS_IDENTITY')
    }))

  it('does not print a safe-shaped nonexistent source filename supplied by the report', () =>
    withReport((fixture) => {
      fixture.report.testResults[0].name = join(
        fixture.context.workspace,
        'src',
        'PRIVATE_SECRET_CANARY.test' + fixtureTsExtension
      )
      const result = diagnose(fixture)
      expectNotPass(result, 'NOT_PASS_IDENTITY')
      expect(JSON.stringify(result.summary)).not.toContain('PRIVATE_SECRET_CANARY')
    }))

  it('rejects source-identity files behind a symlinked directory', () =>
    withReport((fixture) => {
      const alias = join(fixture.context.workspace, 'src', 'alias')
      symlinkSync(
        join(fixture.context.workspace, 'src', 'main'),
        alias,
        process.platform === 'win32' ? 'junction' : 'dir'
      )
      fixture.report.testResults[0].name = join(alias, 'win-security.test' + fixtureTsExtension)
      expectNotPass(diagnose(fixture), 'NOT_PASS_IDENTITY')
    }))

  it.each([
    'context',
    'outside',
    'missing',
    'directory',
    'oversize'
  ])('refuses unsafe or unavailable input: %s', (kind) =>
    withReport((fixture) => {
      if (kind === 'context') fixture.context.runAttempt = canary
      if (kind === 'outside') fixture.context.reportPath = join(fixture.folder, 'foreign.json')
      if (kind === 'directory') mkdirSync(fixture.context.reportPath)
      if (kind === 'oversize') {
        writeFileSync(fixture.context.reportPath, '')
        truncateSync(fixture.context.reportPath, MAX_REPORT_BYTES + 1)
      }
      expectNotPass(
        diagnoseRootReport(fixture.context),
        `NOT_PASS_${{ context: 'CONTEXT', outside: 'PATH', missing: 'MISSING', directory: 'PATH', oversize: 'LIMIT' }[kind]}`
      )
    }))

  it('refuses a symlink input before opening any bytes', () =>
    withReport((fixture) => {
      const linkMetadata = new Proxy(fs.lstatSync(fixture.context.runnerTemp), {
        get(target, key) {
          if (key === 'isSymbolicLink') return () => true
          const value = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
      let opened = false
      const io = {
        ...fs,
        lstatSync: () => linkMetadata,
        openSync: () => {
          opened = true
          throw new Error(canary)
        }
      }
      expectNotPass(diagnoseRootReport(fixture.context, io), 'NOT_PASS_PATH')
      expect(opened).toBe(false)
    }))

  it('rejects a real parent symlink escape without platform skip allowances', () =>
    withReport((fixture) => {
      const outside = join(fixture.folder, 'outside')
      mkdirSync(outside)
      const alias = join(fixture.context.runnerTemp, 'alias')
      symlinkSync(outside, alias, process.platform === 'win32' ? 'junction' : 'dir')
      fixture.context.reportPath = join(alias, 'metis-ci-root-report-123-2-windows-latest.json')
      expectNotPass(diagnoseRootReport(fixture.context), 'NOT_PASS_PATH')
    }))

  it('bounds reads even when initial metadata claims a smaller file, closes and suppresses I/O errors', () =>
    withReport((fixture) => {
      writeFileSync(fixture.context.reportPath, JSON.stringify(fixture.report))
      let closed = false
      const io = {
        ...fs,
        readSync: () => {
          throw new Error(canary)
        },
        closeSync: (fd: number) => {
          closed = true
          fs.closeSync(fd)
        }
      }
      expectNotPass(diagnoseRootReport(fixture.context, io), 'NOT_PASS_UNREADABLE')
      expect(closed).toBe(true)
      const before = fs.lstatSync(fixture.context.reportPath)
      const huge = { ...before, size: MAX_REPORT_BYTES + 1 }
      expectNotPass(diagnoseRootReport(fixture.context, { ...fs, fstatSync: () => huge }), 'NOT_PASS_LIMIT')
    }))

  it.each([
    'complete',
    'limit',
    'unstable',
    'read-failed'
  ] as const)('keeps close failure authoritative after a %s read without leaking diagnostics', (kind) =>
    withReport((fixture) => {
      let closeCalls = 0
      const io = {
        ...fs,
        fstatSync: (fd: number) => {
          const metadata = fs.fstatSync(fd)
          if (kind === 'limit') metadata.size = MAX_REPORT_BYTES + 1
          if (kind === 'unstable') metadata.mtimeMs += 1
          return metadata
        },
        readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: null) => {
          if (kind === 'read-failed') throw new Error(canary)
          return fs.readSync(fd, buffer, offset, length, position)
        },
        closeSync: (fd: number) => {
          closeCalls += 1
          fs.closeSync(fd)
          throw new Error(canary)
        }
      }
      expectNotPass(diagnose(fixture, io), 'NOT_PASS_UNREADABLE')
      expect(closeCalls).toBe(1)
    }))

  it.each([
    ['opened descriptor', 1],
    ['post-read descriptor', 2]
  ] as const)('rejects a swapped %s identity snapshot', (_checkpoint, mismatchAtFstat) =>
    withReport((fixture) => {
      writeFileSync(fixture.context.reportPath, JSON.stringify(fixture.report))
      let stats = 0
      let initialReportIno: number | null = null
      const io = {
        ...fs,
        lstatSync: (path: Parameters<typeof fs.lstatSync>[0]) => {
          const stat = fs.lstatSync(path)
          if (path === fixture.context.reportPath && initialReportIno === null) initialReportIno = stat.ino
          return stat
        },
        fstatSync: (fd: number) => {
          const stat = fs.fstatSync(fd)
          stats += 1
          return stats === mismatchAtFstat
            ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
                ino:
                  initialReportIno === Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER - 1 : Number.MAX_SAFE_INTEGER
              })
            : stat
        }
      }
      expectNotPass(diagnoseRootReport(fixture.context, io), 'NOT_PASS_UNSTABLE')
    }))

  it('rejects excessive skip identities instead of emitting a truncated successful inventory', () =>
    withReport((fixture) => {
      expectNotPass(diagnose(fixture), 'NOT_PASS_LIMIT')
    }, 513))

  it('rejects growth while keeping the read allocation bounded by the initial size plus one', () =>
    withReport((fixture) => {
      writeFileSync(fixture.context.reportPath, JSON.stringify(fixture.report))
      const before = fs.statSync(fixture.context.reportPath)
      let requested = 0
      const io = {
        ...fs,
        readSync: (_fd: number, buffer: Buffer, offset: number, length: number) => {
          requested += length
          buffer.fill(0, offset, offset + length)
          return length
        }
      }
      expectNotPass(diagnoseRootReport(fixture.context, io), 'NOT_PASS_UNSTABLE')
      expect(requested).toBe(before.size + 1)
    }))

  it('does not offer a fallback process, storage or raw exception output in the real producer', () => {
    const producer = readFileSync(join(root, 'scripts', 'ci', 'root-report-diagnostic.mjs'), 'utf8')
    expect(producer).not.toMatch(
      /child_process|execFile|spawn\(|writeFile|appendFile|GITHUB_OUTPUT|GITHUB_STEP_SUMMARY|failureMessages|\.stack|error\.message/
    )
    expect(producer).toContain('process.exitCode = result.exitCode')
    expect(producer).toContain('console.log(JSON.stringify(result.summary))')
    expect(producer).toContain('reportPath: env.METIS_CI_ROOT_REPORT')
    expectOutcomeEnvironmentBindings(producer)
    expect(producer).not.toContain('process.exitCode = 0')
  })

  it.each([
    'complete',
    'missing',
    'failed'
  ])('binds the actual CLI environment to real diagnosis, safe stdout and exit status: %s', (kind) =>
    withReport((fixture) => {
      const assertion = fixture.report.testResults[0].assertionResults[1]
      assertion.title = canary
      assertion.fullName = canary
      assertion.ancestorTitles = [canary]
      assertion.failureMessages = [canary]
      if (kind === 'failed') {
        fixture.report.success = false
        fixture.report.numPassedTestSuites -= 1
        fixture.report.numFailedTestSuites += 1
        fixture.report.testResults[0].status = 'failed'
        fixture.context.pipelineOutcome = 'failure'
        fixture.context.auditOutcome = 'skipped'
      }
      if (kind !== 'missing') writeFileSync(fixture.context.reportPath, JSON.stringify(fixture.report))
      const producerPath = join(root, 'scripts', 'ci', 'root-report-diagnostic.mjs')
      const producer = readFileSync(producerPath, 'utf8')
      const anchor = 'if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {'
      expect(producer.split(anchor)).toHaveLength(2)
      // Execute the actual CLI block with the real reader; only import.meta syntax needs substitution.
      const cli = producer.slice(producer.indexOf(anchor)).replaceAll('import.meta.url', 'moduleUrl')
      const context = fixture.context
      const processFixture = {
        argv: ['node', producerPath],
        exitCode: undefined as number | undefined,
        env: {
          CI: context.ci,
          GITHUB_ACTIONS: context.githubActions,
          METIS_CI_RUNNER_TEMP: context.runnerTemp,
          METIS_CI_WORKSPACE: context.workspace,
          METIS_CI_RUN_ID: context.runId,
          METIS_CI_RUN_ATTEMPT: context.runAttempt,
          METIS_CI_MATRIX_OS: context.matrixOs,
          METIS_CI_ROOT_REPORT: context.reportPath,
          METIS_CI_PIPELINE_OUTCOME: context.pipelineOutcome,
          METIS_CI_AUDIT_OUTCOME: context.auditOutcome,
          PRIVATE_DIAGNOSTIC_CANARY: canary
        }
      }
      let fallbackAttempts = 0
      Object.defineProperty(processFixture, 'execPath', {
        get() {
          fallbackAttempts += 1
          throw new Error('Forbidden fallback capability')
        }
      })
      const output: unknown[] = []
      const execute = new Function(
        'process',
        'console',
        'diagnoseRootReport',
        'pathToFileURL',
        'resolve',
        'moduleUrl',
        cli
      )
      execute(
        processFixture,
        { log: (line: unknown) => output.push(line) },
        diagnoseRootReport,
        pathToFileURL,
        resolve,
        pathToFileURL(producerPath).href
      )
      expect(output).toHaveLength(1)
      const text = String(output[0])
      const summary = JSON.parse(text) as { status: string; authority: string; skips?: unknown[] }
      expect(summary.authority).toBe('UNATTESTED_DIAGNOSTIC_ONLY')
      expect(summary.status).toBe(
        { complete: 'DIAGNOSTIC_COMPLETE', missing: 'NOT_PASS_MISSING', failed: 'NOT_PASS_ROOT_FAILED' }[kind]
      )
      expect(processFixture.exitCode).toBe(kind === 'complete' ? 0 : 1)
      expect(text).not.toContain(canary)
      expect(text).not.toContain(fixture.folder)
      expect(fallbackAttempts).toBe(0)
      if (kind !== 'missing') expect(summary.skips).toHaveLength(2)
    }))
})
