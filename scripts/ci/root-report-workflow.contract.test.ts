import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')
const workflow = readFileSync(join(root, '.github', 'workflows', 'build.yml'), 'utf8').replace(/\r\n/g, '\n')
const project = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }

function qualityJob(): string {
  const lines = workflow.split('\n')
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
    const rootReportEnv =
      '        env:\n' +
      '          METIS_CI_ROOT_REPORT: ${{ runner.temp }}/metis-ci-root-report-' +
      '${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.os }}.json'
    expect(test).toContain(rootReportEnv)
    expect(audit).toContain(rootReportEnv)
    expect(workflow.replace(test, '').replace(audit, '')).not.toContain('METIS_CI_ROOT_REPORT')
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
    expect(audit).not.toMatch(/continue-on-error|\|\||npx\s+vitest/)
    expect(job.indexOf(test)).toBeLessThan(job.indexOf(audit))
  })

  it('preserves committed bytes before the sole Windows quality checkout', () => {
    const job = qualityJob()
    const checkout = '      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0'
    const policy = namedStep(job, 'Preserve committed bytes on Windows checkouts')
    expect(job.match(/^      (?:- |  )uses: actions\/checkout@/gm)).toHaveLength(1)
    expect(job.split(checkout)).toHaveLength(2)
    expect(policy).toContain("        if: runner.os == 'Windows'")
    expect(policy).toContain('        shell: bash\n        run: git config --global core.autocrlf false')
    expect(job.indexOf(policy)).toBeLessThan(job.indexOf(checkout))
    expect(job.replace(policy, '')).not.toMatch(/core\.autocrlf/)
  })

  it('provisions the bounded SRI archive and seven raw caller inputs before the root pipeline', () => {
    const job = qualityJob()
    const producer = namedStep(job, 'Prepare pinned KaTeX evidence inputs')
    const test = namedStep(job, 'Run complete test pipeline')
    expect(producer).not.toMatch(/^ {8}if:|continue-on-error|catch\s*(?:\([^)]*\)\s*)?\{|process\.env\.[A-Z_]+\s*\?\?/m)
    expect(producer).toContain(
      'RENDERER_KATEX_ARCHIVE_DIR: ${{ runner.temp }}/renderer-katex-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.os }}'
    )
    expect(producer).toMatch(/fetch\(url, \{ redirect: 'error' \}\)[\s\S]*if \(!response\.ok \|\| !response\.body\)/)
    expect(producer).toContain('https://registry.npmjs.org/katex/-/katex-0.18.2.tgz')
    expect(producer).toContain(
      'sha512-3snve4y0SXTMequLim1FMiPvLGElySam0blN5xQZBqEY3lOJz1TnuaaiugnBZBqHzlSAGmFTYL7MCQkORuLKCA=='
    )
    expect(producer).toMatch(/bytes > 32 \* 1024 \* 1024[\s\S]*chunks\.push\(Buffer\.from\(part\.value\)\)/)
    expect(producer).toMatch(
      /createHash\('sha512'\)[\s\S]*if \(sri !== integrity\) throw[\s\S]*writeFileSync\(archivePath, archive, \{ flag: 'wx' \}\)/
    )
    expect(producer).toMatch(/writeFileSync\(join\(dir, 'identity\.json'\),[\s\S]*\{ flag: 'wx' \}\)/)
    expect(producer).toMatch(
      /const files = \[\s*'electron\.vite\.config\.ts',\s*'package\.json',\s*'package-lock\.json',\s*'electron-builder\.yml',\s*'electron-builder\.win\.yml',\s*'scripts\/before-pack\.mjs',\s*'scripts\/design\/renderer-inputs\.ts'\s*\]/
    )
    expect(producer).toMatch(
      /openSync\(path, 'r'\)[\s\S]*Buffer\.alloc\(2 \* 1024 \* 1024\)[\s\S]*readSync\(fd, raw,[\s\S]*readSync\(fd, Buffer\.alloc\(1\),[\s\S]*finally \{\s*closeSync\(fd\)/
    )
    expect(producer).toContain("createHash('sha256').update(raw.subarray(0, bytes))")
    expect(producer).toMatch(
      /\['rev-parse', 'HEAD'\][\s\S]*if \(observation\.sourceCommit !== process\.env\.GITHUB_SHA\) throw/
    )
    expect(producer).toContain("'package.json': 'dddf43f8fcd0a8b353b5b29ed9fa316486a668955ad56161e707f71f56b2ad06'")
    expect(producer).toContain(
      "'package-lock.json': 'f2cedcad1b2b67c9f9fb780d24ab6c8dde6dfa65ae0a76432038450d2a41746c'"
    )
    expect(producer).toMatch(/inputs\.find\(\(input\) => input\.path === path\)\?\.sha256 !== hash\)\s*throw/)
    expect(producer).toMatch(
      /Buffer\.byteLength\(output\) > 8 \* 1024[\s\S]*console\.log\(output\)[\s\S]*RENDERER_CALLER_SOURCE_HEAD_MISMATCH[\s\S]*RENDERER_CALLER_PACKAGE_HASH_MISMATCH/
    )
    expect(producer).toContain(
      "writeFileSync(process.env.GITHUB_ENV, `RENDERER_KATEX_TARBALL=${archivePath}\\n`, { flag: 'a' })"
    )
    expect(producer.indexOf('RENDERER_CALLER_PACKAGE_HASH_MISMATCH')).toBeLessThan(
      producer.indexOf('writeFileSync(process.env.GITHUB_ENV')
    )
    expect(job.indexOf(producer)).toBeLessThan(job.indexOf(test))
    expect(test).toContain('&& npm test')
    expect(test).toContain('METIS_CI_ROOT_REPORT')
    expect(test).toContain(
      'node -e "require(\'node:fs\').rmSync(process.env.METIS_CI_ROOT_REPORT, { force: true })" && npm test'
    )
  })
})
