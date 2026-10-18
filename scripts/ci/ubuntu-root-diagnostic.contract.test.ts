import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')
const readWorkflow = (): string =>
  readFileSync(join(root, '.github', 'workflows', 'ubuntu-root-diagnostic.yml'), 'utf8').replace(/\r\n/g, '\n')
const report =
  '${{ runner.temp }}/metis-ci-root-report-${{ github.run_id }}-${{ github.run_attempt }}-ubuntu-latest.json'
const attempted =
  "${{ !cancelled() && (steps.complete_tests.outcome == 'success' || steps.complete_tests.outcome == 'failure') }}"

function step(source: string, name: string): string {
  const lines = source.split('\n')
  const header = `      - name: ${name}`
  expect(lines.filter((line) => line === header)).toHaveLength(1)
  const start = lines.indexOf(header)
  const end = lines.findIndex((line, index) => index > start && /^ {6}- /.test(line))
  return lines.slice(start, end === -1 ? undefined : end).join('\n')
}

function expectDiagnosticWorkflow(source: string): void {
  expect(source).toContain('name: Ubuntu root suite diagnostics\n')
  expect(source).toContain('permissions:\n  contents: read\n')
  expect(source.match(/^ {2}[a-z][a-z0-9_-]*:\n/gm)).toEqual(['  push:\n', '  root-diagnostic:\n'])
  expect(source).toContain('    runs-on: ubuntu-latest\n')
  expect(source).toContain('    timeout-minutes: 30\n')
  expect(source).toContain('actions/checkout@11d5960a326750d5838078e36cf38b85af677262')
  expect(source).toContain('actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020')
  expect(source).toContain('          fetch-depth: 0\n          persist-credentials: false\n')
  expect(source).toContain('          node-version: 22.22.3\n')
  expect(source).toContain('      - run: npm ci\n      - run: npm run typecheck\n      - run: npm run build\n')
  expect(source).toContain('        run: npx playwright install --with-deps chromium\n')
  expect(source).not.toMatch(/continue-on-error|secrets\.|contents: write|id-token:|self-hosted|\|\| true/)
  const producer = step(source, 'Run complete test pipeline')
  const audit = step(source, 'Audit declared skips from root report')
  const diagnostic = step(source, 'Log bounded root report diagnostic')
  const retention = step(source, 'Retain original root test report')
  for (const block of [producer, audit, diagnostic]) {
    expect(block).toContain(`          METIS_CI_ROOT_REPORT: ${report}\n`)
  }
  expect(producer).toContain('        id: complete_tests\n')
  expect(producer).toContain(
    '        run: |\n          node -e "require(\'node:fs\').rmSync(process.env.METIS_CI_ROOT_REPORT, { force: true })" && npm test'
  )
  expect(source.match(/^ {10}.*\bnpm test\b/gm)).toHaveLength(1)
  expect(audit).toContain('        id: declared_skips\n')
  expect(audit).toContain(`        if: ${attempted}\n`)
  expect(audit).toContain('        run: npm run check:skips -- "${{ env.METIS_CI_ROOT_REPORT }}"')
  expect(diagnostic).toContain('        if: ${{ always() }}\n')
  expect(diagnostic).toContain('        run: node scripts/ci/root-report-diagnostic.mjs')
  for (const binding of [
    'METIS_CI_RUNNER_TEMP: ${{ runner.temp }}',
    'METIS_CI_WORKSPACE: ${{ github.workspace }}',
    'METIS_CI_RUN_ID: ${{ github.run_id }}',
    'METIS_CI_RUN_ATTEMPT: ${{ github.run_attempt }}',
    'METIS_CI_MATRIX_OS: ubuntu-latest',
    'METIS_CI_PIPELINE_OUTCOME: ${{ steps.complete_tests.outcome }}',
    'METIS_CI_AUDIT_OUTCOME: ${{ steps.declared_skips.outcome }}'
  ])
    expect(diagnostic).toContain(`          ${binding}\n`)
  expect(retention).toContain(`        if: ${attempted}\n`)
  expect(retention).toContain(
    '        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2\n'
  )
  expect(retention).toContain(`          path: ${report}\n`)
  expect(retention).toContain(
    '          name: metis-ci-root-report-${{ github.run_id }}-${{ github.run_attempt }}-ubuntu-latest\n'
  )
  expect(retention).toContain(
    '          if-no-files-found: error\n          retention-days: 1\n          overwrite: false'
  )
  expect(retention.match(/^ {10}[a-z][a-z-]*:/gm)).toHaveLength(5)
  expect(retention).not.toMatch(/^\s+(run|env|shell):/m)
  expect(source.indexOf(producer)).toBeLessThan(source.indexOf(audit))
  expect(source.indexOf(audit)).toBeLessThan(source.indexOf(diagnostic))
  expect(source.indexOf(diagnostic)).toBeLessThan(source.indexOf(retention))
}

describe('independent Ubuntu root diagnostic evidence', () => {
  it('runs the unchanged pipeline and strict audit on standard hosted CI with original report retention', () => {
    expectDiagnosticWorkflow(readWorkflow())
  })

  it.each([
    ['foreign report', 'METIS_CI_ROOT_REPORT: ' + report, 'METIS_CI_ROOT_REPORT: /tmp/foreign.json'],
    ['success-only audit', `if: ${attempted}`, 'if: success()'],
    ['weakened pipeline', '&& npm test', '&& npx vitest run'],
    ['masked failure', '&& npm test', '&& npm test || true'],
    ['broad upload', 'path: ' + report, 'path: ${{ runner.temp }}/**'],
    ['unpinned upload', 'upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02', 'upload-artifact@v4'],
    ['missing report ignored', 'if-no-files-found: error', 'if-no-files-found: ignore'],
    [
      'extra credential',
      '        with:\n          name:',
      '        env:\n          TOKEN: ${{ secrets.EXTRA }}\n        with:\n          name:'
    ]
  ])('rejects diagnostic workflow regression: %s', (_label, before, after) => {
    const source = readWorkflow()
    expect(source).toContain(before)
    expectDiagnosticWorkflow(source)
    expect(() => expectDiagnosticWorkflow(source.replace(before, after))).toThrow()
  })

  it('keeps the original architecture and packaging dependencies blocking in Build & Test', () => {
    const build = readFileSync(join(root, '.github', 'workflows', 'build.yml'), 'utf8').replace(/\r\n/g, '\n')
    const architecture = step(build, 'Architecture ratchet')
    expect(architecture).toContain("        if: runner.os == 'Linux'\n        run: npm run check:architecture")
    expect(architecture).not.toContain('continue-on-error')
    expect(build.match(/^ {4}needs: \[quality, security\]$/gm)).toHaveLength(2)
    expect(build).not.toContain('ubuntu-root-diagnostic')
  })
})
