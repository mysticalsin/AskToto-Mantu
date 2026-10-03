import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { countByFile, formatIsBlocking, lintablePaths, regressions } from './lint-ratchet.mjs'

/**
 * lint-ratchet.contract.test.ts — M2-0052. The lint gate lets a changed file keep the diagnostics it already had
 * and fails it the moment it gains one; a new file starts from zero. These tests pin that arithmetic and the
 * wiring (biome.json rules, npm scripts, blocking lint step, format step whose blocking date the script owns).
 */

const root = join(__dirname, '..', '..')
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8').replace(/\r\n/g, '\n')

describe('lintablePaths', () => {
  it('keeps source files and drops docs, config and generated output', () => {
    expect(
      lintablePaths([
        'src/a.ts',
        'src/b.tsx',
        'scripts/c.mjs',
        'README.md',
        'package.json',
        'operator/src/spa/client.generated.ts'
      ])
    ).toEqual(['src/a.ts', 'src/b.tsx', 'scripts/c.mjs'])
  })

  it('drops source files outside the roots biome.json lints, so an all-ignored change set is empty', () => {
    expect(lintablePaths(['vitest.config.ts', 'native/tool.js', 'docs/x.mjs'])).toEqual([])
  })

  it('keeps exactly the roots listed in biome.json files.includes', () => {
    const config = JSON.parse(read('biome.json')) as { files: { includes: string[] } }
    const roots = config.files.includes.filter((g) => !g.startsWith('!')).map((g) => g.replace(/\*\*$/, ''))
    expect(lintablePaths(roots.map((r) => `${r}x.ts`))).toHaveLength(roots.length)
  })
})

describe('formatIsBlocking', () => {
  it('is report-only through 2026-10-05 and blocking from 2026-10-06', () => {
    expect(formatIsBlocking(new Date('2026-09-29T12:00:00Z'))).toBe(false)
    expect(formatIsBlocking(new Date('2026-10-05T23:59:59Z'))).toBe(false)
    expect(formatIsBlocking(new Date('2026-10-06T00:00:00Z'))).toBe(true)
    expect(formatIsBlocking(new Date('2027-01-01T00:00:00Z'))).toBe(true)
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

  it('runs lint and format as job-failing steps in build.yml (the script owns the format date)', () => {
    const workflow = read('.github', 'workflows', 'build.yml')
    const start = workflow.indexOf('\n  lint:\n')
    expect(start).toBeGreaterThan(-1)
    const block = workflow.slice(start + 1, workflow.indexOf('\n  license-server:\n'))
    expect(block).toContain('fetch-depth: 0')
    expect(block).toMatch(/- name: Lint ratchet \(changed files\)\n {8}run: npm run lint:changed\n/)
    expect(block).toMatch(/- name: Format check \(changed files\)\n {8}run: npm run format:changed\n/)
    expect(block).not.toContain('continue-on-error')
  })
})
