import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { countByFile, lintablePaths, regressions } from './lint-ratchet.mjs'

/**
 * lint-ratchet.contract.test.ts — M2-0052. The lint gate lets a changed file keep the diagnostics it already had
 * and fails it the moment it gains one; a new file starts from zero. These tests pin that arithmetic and the
 * wiring (biome.json rules, npm scripts, blocking lint step, report-only format step).
 */

const root = join(__dirname, '..', '..')
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8').replace(/\r\n/g, '\n')

describe('lintablePaths', () => {
  it('keeps source files and drops docs, config and generated output', () => {
    expect(
      lintablePaths(['src/a.ts', 'src/b.tsx', 'scripts/c.mjs', 'README.md', 'package.json', 'operator/src/spa/client.generated.ts'])
    ).toEqual(['src/a.ts', 'src/b.tsx', 'scripts/c.mjs'])
  })
})

describe('countByFile', () => {
  it('counts diagnostics per file and normalises path separators', () => {
    const report = JSON.stringify({
      diagnostics: [
        { location: { path: { file: 'src/a.ts' } } },
        { location: { path: { file: './src/a.ts' } } },
        { location: { path: { file: 'src\\b.ts' } } },
        { description: 'no location' }
      ]
    })
    expect(countByFile(report)).toEqual({ 'src/a.ts': 2, 'src/b.ts': 1 })
  })

  it('treats a report with no diagnostics as clean', () => {
    expect(countByFile('{"summary":{}}')).toEqual({})
  })
})

describe('regressions', () => {
  it('passes a file that keeps or reduces its baselined diagnostics', () => {
    expect(regressions({ 'a.ts': 3, 'b.ts': 2 }, { 'a.ts': 3, 'b.ts': 1 })).toEqual([])
  })

  it('fails a file that gains a diagnostic over its baseline', () => {
    expect(regressions({ 'a.ts': 3 }, { 'a.ts': 4 })).toEqual([{ file: 'a.ts', base: 3, head: 4 }])
  })

  it('holds a file new on the branch to zero', () => {
    expect(regressions({}, { 'new.ts': 1 })).toEqual([{ file: 'new.ts', base: 0, head: 1 }])
  })
})

describe('wiring', () => {
  it('biome.json enables only correctness lint rules', () => {
    const config = JSON.parse(read('biome.json'))
    expect(config.linter.rules.recommended).toBe(false)
    expect(Object.keys(config.linter.rules).sort()).toEqual(['correctness', 'recommended'])
    expect(new Set(Object.values(config.linter.rules.correctness))).toEqual(new Set(['error']))
  })

  it('exposes the changed-file scripts', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
    expect(pkg.scripts['lint:changed']).toBe('node scripts/ci/lint-ratchet.mjs lint')
    expect(pkg.scripts['format:changed']).toBe('node scripts/ci/lint-ratchet.mjs format')
  })

  it('runs lint as a blocking step and format as a report-only step in build.yml', () => {
    const workflow = read('.github', 'workflows', 'build.yml')
    const start = workflow.indexOf('\n  lint:\n')
    expect(start).toBeGreaterThan(-1)
    const block = workflow.slice(start + 1, workflow.indexOf('\n  license-server:\n'))
    expect(block).toContain('fetch-depth: 0')
    expect(block).toMatch(/- name: Lint ratchet \(changed files\)\n {8}run: npm run lint:changed\n/)
    expect(block).toMatch(
      /- name: Format check \(changed files\)\n {8}continue-on-error: true\n {8}run: npm run format:changed\n/
    )
  })
})
