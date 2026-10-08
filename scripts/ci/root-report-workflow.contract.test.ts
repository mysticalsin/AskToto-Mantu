import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')
const workflow = readFileSync(join(root, '.github', 'workflows', 'build.yml'), 'utf8').replace(/\r\n/g, '\n')
const project = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }

function qualityJob(): string {
  const lines = workflow.split('\n')
  const header = '  quality:'
  expect(lines.filter((line) => line === header), 'one quality job').toHaveLength(1)
  const start = lines.indexOf(header)
  const end = lines.findIndex((line, index) => index > start && /^ {2}[A-Za-z0-9_-]+:/.test(line))
  return lines.slice(start, end === -1 ? undefined : end).join('\n')
}

function namedStep(job: string, name: string): string {
  const lines = job.split('\n')
  const header = `      - name: ${name}`
  expect(lines.filter((line) => line === header), `one ${name} step`).toHaveLength(1)
  const start = lines.indexOf(header)
  const end = lines.findIndex((line, index) => index > start && /^ {6}- /.test(line))
  return lines.slice(start, end === -1 ? undefined : end).join('\n')
}

describe('root Vitest report handoff workflow', () => {
  it('keeps npm test as the sole mode-lock, root, proxy, and Operator pipeline', () => {
    expect(project.scripts.test).toBe(
      'node scripts/lock-mode-skills.mjs --check && vitest run && npm run test:proxy && npm run test:operator'
    )
  })

  it('uses one quality-scoped fresh report path tied to this hosted matrix attempt', () => {
    const job = qualityJob()
    const rootReportEnv =
      '    env:\n' +
      '      METIS_CI_ROOT_REPORT: ${{ runner.temp }}/metis-ci-root-report-' +
      '${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.os }}.json'
    expect(job).toContain(rootReportEnv)
    expect(workflow.replace(job, '')).not.toContain('METIS_CI_ROOT_REPORT')
  })

  it('clears only that report before the unchanged npm test chain and never masks failures', () => {
    const job = qualityJob()
    const test = namedStep(job, 'Run complete test pipeline')

    expect(test).toContain('        shell: bash')
    expect(test).toContain('        run: |\n          rm -f -- "$METIS_CI_ROOT_REPORT"\n          npm test')
    expect(test).not.toMatch(/continue-on-error|\|\||npx\s+vitest|--reporter/)
    expect(job).not.toMatch(/continue-on-error:\s*true/)
  })

  it('passes the same fresh report explicitly to the later skip audit', () => {
    const job = qualityJob()
    const test = namedStep(job, 'Run complete test pipeline')
    const audit = namedStep(job, 'Audit declared skips from root report')

    expect(audit).toContain('        shell: bash')
    expect(audit).toContain('        run: npm run check:skips -- "$METIS_CI_ROOT_REPORT"')
    expect(audit).not.toMatch(/continue-on-error|\|\||npx\s+vitest/)
    expect(job.indexOf(test)).toBeLessThan(job.indexOf(audit))
  })
})
