import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  compareCounts,
  countDependencyViolations,
  countSourceFile,
  formatBaseline,
  lowerBaseline,
  renderSizeScheduleBlock,
  sizeScheduleDocIsCurrent,
  validateSizeSchedule,
} from './check-architecture.mjs'

type Counts = Record<string, Record<string, number>>
type Difference = { rule: string; file: string; baseline: number; current: number }

const RULE_IDS = [
  'FF-01',
  'FF-02',
  'FF-03',
  'FF-04',
  'FF-05a',
  'FF-05b',
  'FF-06',
  'FF-07',
  'FF-09',
  'FF-10',
  'FF-11',
  'FF-14',
]

function sortedViolationLines(stdout: string): string[] {
  const report = JSON.parse(stdout) as {
    summary: { violations: Array<{ rule: { name: string; severity: string }; from: string }> }
  }
  return report.summary.violations
    .map((violation) => `${violation.rule.name} ${violation.rule.severity} ${violation.from}`)
    .sort()
}

function runDependencyCruiser(fixtureRoot: string, outputType: 'json' | 'default'): { code: number; out: string } {
  const bin = join(fixtureRoot, 'node_modules', 'dependency-cruiser', 'bin', 'dependency-cruiser.mjs')
  const args =
    outputType === 'json'
      ? [bin, 'src', '--config', '.dependency-cruiser.cjs', '--output-type', 'json', '--no-progress']
      : [bin, 'src', '--config', '.dependency-cruiser.cjs']
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, args, { cwd: fixtureRoot, encoding: 'utf8' }),
    }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

function writeFixtureFile(root: string, path: string, text: string): void {
  const absolute = join(root, path)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, text)
}

function readTrailingJson(stdout: string): Counts {
  const trimmed = stdout.trimEnd()
  for (let index = trimmed.lastIndexOf('\n{'); index >= 0; index = trimmed.lastIndexOf('\n{', index - 1)) {
    const candidate = trimmed.slice(index + 1)
    try {
      return JSON.parse(candidate) as Counts
    } catch {
      continue
    }
  }
  return JSON.parse(trimmed) as Counts
}

function runArchitectureCli(fixtureRoot: string): { code: number; out: string } {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [join(fixtureRoot, 'scripts', 'check-architecture.mjs')], {
        cwd: fixtureRoot,
        encoding: 'utf8',
      }),
    }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

function createLayeringFixture(): { root: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'metis-architecture-')))
  const nodeModules = join(root, 'node_modules')
  symlinkSync(
    join(__dirname, '..', 'node_modules'),
    nodeModules,
    process.platform === 'win32' ? 'junction' : 'dir',
  )

  copyFileSync(join(__dirname, '..', '.dependency-cruiser.cjs'), join(root, '.dependency-cruiser.cjs'))
  writeFixtureFile(root, 'tsconfig.web.json', JSON.stringify({
    compilerOptions: {
      baseUrl: '.',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      paths: {
        '@/*': ['src/*'],
        '@shared/*': ['src/shared/*'],
      },
      skipLibCheck: true,
      strict: true,
      target: 'ES2022',
    },
    include: ['src/**/*.ts', 'src/**/*.tsx'],
  }, null, 2))

  writeFixtureFile(root, 'src/main/index.ts', [
    "import './infra/x'",
    "import './features/a/use-b'",
    "import '../shared/contracts/schema'",
    "import '../cycle/a'",
    "import '@shared/alias-target'",
    "import '@/alias-root'",
    'export const entry = true',
  ].join('\n'))
  writeFixtureFile(root, 'src/main/service.ts', 'export const service = true\n')
  writeFixtureFile(root, 'src/renderer/src/main.tsx', [
    "import '../../main/service'",
    'export const rendererEntry = true',
  ].join('\n'))
  writeFixtureFile(root, 'src/renderer/src/cross.test.ts', [
    "import '../../main/service'",
    'export const rendererTest = true',
  ].join('\n'))
  writeFixtureFile(root, 'src/main/infra/x.ts', [
    "import '../features/a/index'",
    'export const infra = true',
  ].join('\n'))
  writeFixtureFile(root, 'src/main/features/a/index.ts', 'export const featureA = true\n')
  writeFixtureFile(root, 'src/main/features/a/use-b.ts', [
    "import '../b/internal'",
    "import '../b/index'",
    'export const useB = true',
  ].join('\n'))
  writeFixtureFile(root, 'src/main/features/b/index.ts', 'export const featureB = true\n')
  writeFixtureFile(root, 'src/main/features/b/internal.ts', 'export const internalB = true\n')
  writeFixtureFile(root, 'src/shared/contracts/schema.ts', [
    "import { z } from 'zod'",
    "import '../util'",
    'export const schema = z.object({ ok: z.boolean() })',
  ].join('\n'))
  writeFixtureFile(root, 'src/shared/util.ts', 'export const util = true\n')
  writeFixtureFile(root, 'src/cycle/a.ts', [
    "import './b'",
    'export const cycleA = true',
  ].join('\n'))
  writeFixtureFile(root, 'src/cycle/b.ts', [
    "import './a'",
    'export const cycleB = true',
  ].join('\n'))
  writeFixtureFile(root, 'src/dead.ts', 'export const dead = true\n')
  // Test-only helper no entry point reaches: FF-03 must not count it (dead.ts above is still counted).
  writeFixtureFile(root, 'src/main/test-helpers/settle.ts', 'export const settle = true\n')
  writeFixtureFile(root, 'src/shared/alias-target.ts', 'export const sharedAlias = true\n')
  writeFixtureFile(root, 'src/alias-root.ts', 'export const rootAlias = true\n')
  writeFixtureFile(root, 'src/renderer/src/lib/whisper.worker.ts', 'export const workerEntry = true\n')

  return { root }
}

function createArchitectureFixture(): { root: string } {
  const fixture = createLayeringFixture()
  mkdirSync(join(fixture.root, 'intelligence', 'src'), { recursive: true })
  mkdirSync(join(fixture.root, 'operator', 'src'), { recursive: true })
  mkdirSync(join(fixture.root, 'scripts'), { recursive: true })
  copyFileSync(
    join(__dirname, 'check-architecture.mjs'),
    join(fixture.root, 'scripts', 'check-architecture.mjs'),
  )
  writeFixtureFile(fixture.root, 'src/new-cycle/a.ts', [
    "import './b'",
    'export const newCycleA = true',
  ].join('\n'))
  writeFixtureFile(fixture.root, 'src/new-cycle/b.ts', 'export const newCycleB = true\n')
  writeFixtureFile(fixture.root, 'src/main/index.ts', [
    "import './infra/x'",
    "import './features/a/use-b'",
    "import '../shared/contracts/schema'",
    "import '../cycle/a'",
    "import '../new-cycle/a'",
    "import './long'",
    "import './fs'",
    "import '@shared/alias-target'",
    "import '@/alias-root'",
    'export const entry = true',
  ].join('\n'))
  writeFixtureFile(fixture.root, 'src/main/long.ts', `${Array.from({ length: 801 }, (_, index) => `export const line${index + 1} = ${index + 1}`).join('\n')}\n`)
  writeFixtureFile(fixture.root, 'src/main/fs.ts', [
    "import { readFileSync } from 'node:fs'",
    "readFileSync('a')",
  ].join('\n'))
  return fixture
}

function removeLayeringErrors(root: string): void {
  writeFixtureFile(root, 'src/renderer/src/main.tsx', 'export const rendererEntry = true\n')
  writeFixtureFile(root, 'src/main/infra/x.ts', 'export const infra = true\n')
  writeFixtureFile(root, 'src/main/features/a/use-b.ts', [
    "import '../b/index'",
    'export const useB = true',
  ].join('\n'))
  writeFixtureFile(root, 'src/shared/contracts/schema.ts', [
    "import { z } from 'zod'",
    'export const schema = z.object({ ok: z.boolean() })',
  ].join('\n'))
}

type SizeSchedule = { rows: Record<string, { owner: string; target: number; by: string; milestone?: string }> }

const row = { owner: 'M2-0001', target: 800, by: '2027-03-31' }

function readRepoJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(__dirname, name), 'utf8')) as T
}

describe('FF-04 size schedule', () => {
  it('accepts a schedule that names exactly the baseline files', () => {
    expect(validateSizeSchedule({ 'src/a.mjs': 900 }, { rows: { 'src/a.mjs': row } })).toEqual([])
  })

  it('fails a baseline entry without a schedule row', () => {
    const problems = validateSizeSchedule({ 'src/a.mjs': 900, 'src/b.mjs': 950 }, { rows: { 'src/a.mjs': row } })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('src/b.mjs')
    expect(problems[0]).toContain('no size-schedule row')
  })

  it('fails a row for a file that is no longer over 800 lines', () => {
    const problems = validateSizeSchedule({ 'src/a.mjs': 900 }, { rows: { 'src/a.mjs': row, 'src/gone.mjs': row } })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('src/gone.mjs')
    expect(problems[0]).toContain('no longer over 800 lines')
  })

  it('fails a row without a ticket owner, a target in 1..800 or an ISO date', () => {
    const baseline = { 'src/a.mjs': 900 }
    expect(validateSizeSchedule(baseline, { rows: { 'src/a.mjs': { ...row, owner: 'someone' } } })).toHaveLength(1)
    expect(validateSizeSchedule(baseline, { rows: { 'src/a.mjs': { ...row, target: 801 } } })).toHaveLength(1)
    expect(validateSizeSchedule(baseline, { rows: { 'src/a.mjs': { ...row, target: 0 } } })).toHaveLength(1)
    expect(validateSizeSchedule(baseline, { rows: { 'src/a.mjs': { ...row, by: 'm10' } } })).toHaveLength(1)
    expect(validateSizeSchedule(baseline, { rows: { 'src/a.mjs': { ...row, by: '2027-13-40' } } })).toHaveLength(1)
  })

  it('renders one sorted row per file and detects a drifted document', () => {
    const schedule: SizeSchedule = {
      rows: { 'src/b.mjs': { ...row, target: 300, milestone: 'm10' }, 'src/a.mjs': row },
    }
    const block = renderSizeScheduleBlock(schedule)
    expect(block.indexOf('src/a.mjs')).toBeLessThan(block.indexOf('src/b.mjs'))
    expect(block).toContain('| 300 | 2027-03-31 (m10) | M2-0001 |')
    expect(sizeScheduleDocIsCurrent(`# Doc\n\n${block}\n`, schedule)).toBe(true)
    expect(sizeScheduleDocIsCurrent(`# Doc\n\n${block.replace('300', '299')}\n`, schedule)).toBe(false)
    expect(sizeScheduleDocIsCurrent('# Doc\n', schedule)).toBe(false)
  })

  it('holds for the committed baseline, schedule and architecture document, with src/main/index at 300 lines by m10', () => {
    const baseline = readRepoJson<Counts>('architecture-baseline.json')
    const schedule = readRepoJson<SizeSchedule>('architecture-size-schedule.json')
    expect(validateSizeSchedule(baseline['FF-04'], schedule)).toEqual([])
    expect(schedule.rows['src/main/index.' + 'ts']).toMatchObject({ target: 300, milestone: 'm10' })
    const doc = readFileSync(join(__dirname, '..', 'docs', 'ARCHITECTURE.md'), 'utf8')
    expect(sizeScheduleDocIsCurrent(doc, schedule)).toBe(true)
  })
})

describe('architecture ratchet pure functions', () => {
  it('returns no differences when baseline and current counts are equal', () => {
    const counts = { 'FF-04': { 'src/main/a.ts': 801 } }
    expect(compareCounts(counts, counts)).toEqual({ regressions: [], stale: [] })
  })

  it('reports a current count above baseline as a regression', () => {
    expect(compareCounts(
      { 'FF-04': { 'src/main/a.ts': 801 } },
      { 'FF-04': { 'src/main/a.ts': 802 } },
    )).toEqual({
      regressions: [{ rule: 'FF-04', file: 'src/main/a.ts', baseline: 801, current: 802 }],
      stale: [],
    })
  })

  it('reports a file present only in current as a regression from zero', () => {
    expect(compareCounts(
      { 'FF-04': {} },
      { 'FF-04': { 'src/main/new.ts': 801 } },
    )).toEqual({
      regressions: [{ rule: 'FF-04', file: 'src/main/new.ts', baseline: 0, current: 801 }],
      stale: [],
    })
  })

  it('reports lower and absent current counts as stale', () => {
    expect(compareCounts(
      { 'FF-04': { 'src/main/a.ts': 801, 'src/main/deleted.ts': 900 } },
      { 'FF-04': { 'src/main/a.ts': 800 } },
    )).toEqual({
      regressions: [],
      stale: [
        { rule: 'FF-04', file: 'src/main/a.ts', baseline: 801, current: 800 },
        { rule: 'FF-04', file: 'src/main/deleted.ts', baseline: 900, current: 0 },
      ],
    })
  })

  it('lowers only stale baseline entries, preserves regressions, drops zeroes, and never invents new files', () => {
    expect(lowerBaseline(
      {
        'FF-04': {
          'src/main/a.ts': 801,
          'src/main/deleted.ts': 900,
          'src/main/regressed.ts': 1,
        },
      },
      {
        'FF-04': {
          'src/main/a.ts': 800,
          'src/main/regressed.ts': 2,
          'src/main/new.ts': 1,
        },
      },
    )).toEqual({
      'FF-04': {
        'src/main/a.ts': 800,
        'src/main/regressed.ts': 1,
      },
    })
  })

  it('formats the canonical baseline in fixed rule order with sorted positive integer entries only', () => {
    const canonical = formatBaseline({
      'FF-05a': {
        'src/main/z.ts': 2,
        'src/main/a.ts': 1,
        'src/main/zero.ts': 0,
        'src/main/float.ts': 1.5,
      },
      'FF-99': { 'src/main/unknown.ts': 1 },
      'FF-04': {
        'src/main/string.ts': '1' as unknown as number,
        'src/main/long.ts': 801,
      },
    })
    expect(canonical).toBe(`${JSON.stringify({
      'FF-01': {},
      'FF-02': {},
      'FF-03': {},
      'FF-04': {
        'src/main/long.ts': 801,
      },
      'FF-05a': {
        'src/main/a.ts': 1,
        'src/main/z.ts': 2,
      },
      'FF-05b': {},
      'FF-06': {},
      'FF-07': {},
      'FF-09': {},
      'FF-10': {},
      'FF-11': {},
      'FF-14': {},
    }, null, 2)}\n`)
    expect(Object.keys(JSON.parse(canonical) as Counts)).toEqual(RULE_IDS)
    expect(formatBaseline(JSON.parse(canonical) as Counts)).toBe(canonical)
  })

  it('maps dependency-cruiser rule names to fitness ids, sums by file, and rejects unknown prefixes', () => {
    expect(countDependencyViolations([
      { rule: { name: 'ff01-renderer-imports-main-or-preload' }, from: 'src/renderer/src/main.tsx' },
      { rule: { name: 'ff01-renderer-imports-main-or-preload-in-tests' }, from: 'src/renderer/src/main.tsx' },
      { rule: { name: 'ff02-import-cycle' }, from: 'src/cycle/a.ts' },
      { rule: { name: 'ff03-unreachable-from-entry-points' }, from: 'src/dead.ts' },
    ])).toEqual({
      'FF-01': { 'src/renderer/src/main.tsx': 2 },
      'FF-02': { 'src/cycle/a.ts': 1 },
      'FF-03': { 'src/dead.ts': 1 },
    })
    expect(() => countDependencyViolations([
      { rule: { name: 'layering-renderer-imports-main' }, from: 'src/renderer/src/main.tsx' },
    ])).toThrow()
    expect(() => countDependencyViolations([
      { rule: { name: 'ff08-some-rule' }, from: 'src/main/a.ts' },
    ])).toThrow()
    expect(() => countDependencyViolations([
      { rule: { name: 'FF01-example' }, from: 'src/main/a.ts' },
    ])).toThrow()
  })
})

describe('architecture source detectors', () => {
  describe('FF-04 lines over 800', () => {
    it('counts only production src files over 800 logical lines', () => {
      const lines801 = Array.from({ length: 801 }, (_, index) => `line${index + 1}`).join('\n')
      const lines800 = Array.from({ length: 800 }, (_, index) => `line${index + 1}`).join('\n')
      const lines900 = Array.from({ length: 900 }, (_, index) => `line${index + 1}`).join('\n')
      expect(countSourceFile('src/main/long.ts', lines801)).toEqual({ 'FF-04': 801 })
      expect(countSourceFile('src/main/exact.ts', lines800)).toEqual({})
      expect(countSourceFile('src/main/crlf.ts', lines801.replace(/\n/g, '\r\n'))).toEqual({ 'FF-04': 801 })
      expect(countSourceFile('src/main/long.test.ts', lines900)).toEqual({})
      expect(countSourceFile('src/main/types.d.ts', lines900)).toEqual({})
      expect(countSourceFile('src/main/__fixtures__/long.ts', lines900)).toEqual({})
    })

    it.each([
      ['src/main', ['ts', 'tsx']],
      ['operator/src', ['ts']],
      ['intelligence/src', ['ts', 'tsx']],
      ['scripts', ['ts', 'mjs']],
    ])('counts a 801-line production file in %s and not a 799-line one', (root, extensions) => {
      const lines = (count: number) => Array.from({ length: count }, (_, index) => `line${index + 1}`).join('\n')
      for (const extension of extensions) {
        const file = `${root}/big.${extension}`
        expect(countSourceFile(file, lines(801))).toEqual({ 'FF-04': 801 })
        expect(countSourceFile(file, lines(799))).toEqual({})
      }
    })

    it('does not count tests, declarations or fixtures under the extended roots', () => {
      const lines900 = Array.from({ length: 900 }, (_, index) => `line${index + 1}`).join('\n')
      for (const root of ['operator/src', 'intelligence/src', 'scripts']) {
        expect(countSourceFile(`${root}/big.test.${'tsx'}`, lines900)).toEqual({})
        expect(countSourceFile(`${root}/big.test.${'mjs'}`, lines900)).toEqual({})
        expect(countSourceFile(`${root}/big.d.${'ts'}`, lines900)).toEqual({})
        expect(countSourceFile(`${root}/__fixtures__/big.${'ts'}`, lines900)).toEqual({})
      }
      expect(countSourceFile(`docs/big.${'ts'}`, lines900)).toEqual({})
      expect(countSourceFile(`operator/scripts/big.${'mjs'}`, lines900)).toEqual({})
      expect(countSourceFile(`src/main/big.${'mjs'}`, lines900)).toEqual({})
    })
  })

  describe('FF-05a synchronous fs calls', () => {
    it('counts fs-bound sync calls only in production src/main files', () => {
      expect(countSourceFile('src/main/fs.ts', [
        "import { readFileSync } from 'node:fs'",
        "import { readFileSync as rf } from 'fs'",
        "import * as fs from 'node:fs'",
        "const { mkdirSync } = require('node:fs')",
        "import { execFileSync } from 'node:child_process'",
        'function writeRunStateSync() {}',
        'readFileSync("a")',
        'rf("b")',
        'fs.writeFileSync("c", "d")',
        'mkdirSync("e")',
        'writeRunStateSync()',
        'execFileSync("node")',
      ].join('\n'))).toEqual({ 'FF-05a': 4, 'FF-10': 1 })
      expect(countSourceFile('src/main/async.ts', [
        "import { readFile } from 'node:fs'",
        "import type { readFileSync } from 'node:fs'",
        'readFile("a", () => {})',
        'readFileSync("b")',
      ].join('\n'))).toEqual({})
      expect(countSourceFile('src/shared/fs.ts', [
        "import { readFileSync } from 'node:fs'",
        'readFileSync("a")',
      ].join('\n'))).toEqual({})
    })
  })

  describe('collectFsBindings gaps', () => {
    it('recognizes default imports, promises aliases, and typed require bindings', () => {
      expect(countSourceFile('src/main/fs-default.ts', [
        "import fs from 'node:fs'",
        "fs.readFileSync('a')",
      ].join('\n'))).toEqual({ 'FF-05a': 1 })
      expect(countSourceFile('scripts/check.promises.test.ts', [
        "import { promises as fsp } from 'node:fs'",
        "fsp.readFile('src/main/index.ts', 'utf8', () => {})",
      ].join('\n'))).toEqual({ 'FF-07': 1 })
      expect(countSourceFile('src/main/fs-as.ts', [
        "const fs = require('node:fs') as typeof import('node:fs')",
        "fs.readFileSync('a')",
      ].join('\n'))).toEqual({ 'FF-05a': 1 })
    })
  })

  describe('FF-05b fs calls in meetings-root modules', () => {
    it('counts sync and async fs reads in exact meetings-root files', () => {
      const text = [
        "import { readFileSync } from 'node:fs'",
        "import { readFile } from 'fs'",
        "import { stat } from 'node:fs/promises'",
        "import * as fs from 'node:fs'",
        'readFileSync("a")',
        'readFile("b", () => {})',
        'stat("c")',
        'fs.promises.stat("d")',
      ].join('\n')
      expect(countSourceFile('src/main/transcripts.ts', text)).toEqual({ 'FF-05a': 1, 'FF-05b': 4 })
      expect(countSourceFile('src/main/other.ts', text)).toEqual({ 'FF-05a': 1 })
    })
  })

  describe('FF-06 native dialogs', () => {
    it('counts native dialog access only in production renderer and intelligence files', () => {
      const text = [
        'window.confirm("ok")',
        'globalThis.alert',
        "self['prompt']",
        'const { confirm } = window',
        'alert("x")',
      ].join('\n')
      expect(countSourceFile('src/renderer/src/App.tsx', text)).toEqual({ 'FF-06': 5 })
      expect(countSourceFile('intelligence/src/App.tsx', text)).toEqual({ 'FF-06': 5 })
      expect(countSourceFile('src/renderer/src/multi-dialog.tsx', 'const { confirm, alert } = window\n')).toEqual({ 'FF-06': 2 })
      expect(countSourceFile('src/renderer/src/shadow.tsx', [
        'const confirm = () => true',
        'confirm()',
      ].join('\n'))).toEqual({})
      expect(countSourceFile('src/renderer/src/param.tsx', [
        'function run(alert: () => void) {',
        '  alert()',
        '}',
      ].join('\n'))).toEqual({})
      expect(countSourceFile('src/main/x.ts', text)).toEqual({})
      expect(countSourceFile('src/renderer/src/App.test.tsx', text)).toEqual({})
    })
  })

  describe('FF-07 test files reading source paths', () => {
    it('counts source-looking path literals only in test files with qualifying fs read bindings', () => {
      expect(countSourceFile('src/main/x.contract.test.ts', [
        "import { readFileSync } from 'node:fs'",
        "import { join } from 'node:path'",
        "const SRC = join(__dirname, '../renderer/src/App.tsx')",
        "readFileSync(join(__dirname, 'index.ts'), 'utf8')",
        "readFileSync(SRC, 'utf8')",
      ].join('\n'))).toEqual({ 'FF-07': 2 })
      expect(countSourceFile('scripts/check.test.ts', [
        "import * as fs from 'node:fs'",
        "fs.readFileSync(`src/main/index.ts`, 'utf8')",
        "fs.readFile('src/renderer/src/App.tsx', 'utf8', () => {})",
      ].join('\n'))).toEqual({ 'FF-07': 2 })
      expect(countSourceFile('scripts/check.test.ts', [
        "import { readFileSync } from 'node:fs'",
        "const dir = 'src/renderer/src'",
        "readFileSync(`${dir}/App.tsx`, 'utf8')",
      ].join('\n'))).toEqual({ 'FF-07': 1 })
      expect(countSourceFile('scripts/check.test.ts', [
        "import { readFileSync } from 'node:fs'",
        "readFileSync('__fixtures__/a.ts', 'utf8')",
        "readFileSync('types.d.ts', 'utf8')",
        "const prose = 'the index.ts file'",
      ].join('\n'))).toEqual({})
      expect(countSourceFile('scripts/check.test.ts', [
        "const source = 'index.ts'",
        'void source',
      ].join('\n'))).toEqual({})
      expect(countSourceFile('src/main/x.ts', [
        "import { readFile } from 'node:fs'",
        "readFile('index.ts', 'utf8', () => {})",
      ].join('\n'))).toEqual({})
    })
  })

  describe('FF-09 ipcMain registrations outside src/main/ipc', () => {
    it('counts ipcMain listener registration outside the ipc directory only', () => {
      const text = [
        'ipcMain.handle("a", fn)',
        'ipcMain.on("b", fn)',
        'electron.ipcMain.handleOnce("c", fn)',
        'ipcMain.once("d", fn)',
        'ipcMain.addListener("e", fn)',
        'ipcRenderer.on("f", fn)',
      ].join('\n')
      expect(countSourceFile('src/main/register.ts', text)).toEqual({ 'FF-09': 5 })
      expect(countSourceFile('src/main/ipc/register.ts', text)).toEqual({})
    })
  })

  describe('FF-10 process spawning outside src/main/infra/process', () => {
    it('counts child_process value imports, requires, and utilityProcess forks outside the process infra', () => {
      const text = [
        "import { spawn } from 'node:child_process'",
        "import type { ChildProcess } from 'node:child_process'",
        "const cp = require('child_process')",
        'utilityProcess.fork(p)',
        'electron.utilityProcess.fork(p)',
      ].join('\n')
      expect(countSourceFile('src/main/spawn.ts', text)).toEqual({ 'FF-10': 4 })
      expect(countSourceFile('src/main/types.ts', "import type { ChildProcess } from 'node:child_process'\n")).toEqual({})
      expect(countSourceFile('src/main/spawn-inline-type.ts', "import { type ChildProcess } from 'node:child_process'\n")).toEqual({})
      expect(countSourceFile('src/main/infra/process/spawn.ts', text)).toEqual({})
    })

    it('counts a utilityProcess.fork reference used as a value, not only as a call', () => {
      const text = 'function run({ fork = utilityProcess.fork as unknown as F } = {}) {}'
      expect(countSourceFile('src/main/fork-ref.ts', text)).toEqual({ 'FF-10': 1 })
    })
  })

  describe('FF-11 BrowserWindow construction outside src/main/windows', () => {
    it('counts BrowserWindow construction outside the windows directory only', () => {
      const text = [
        'new BrowserWindow({})',
        'new electron.BrowserWindow({})',
      ].join('\n')
      expect(countSourceFile('src/main/create-window.ts', text)).toEqual({ 'FF-11': 2 })
      expect(countSourceFile('src/main/windows/create-window.ts', text)).toEqual({})
    })
  })

  describe('FF-14 background timers outside src/main/infra/scheduler', () => {
    it('counts background intervals and self-rearming timeouts in src/main only', () => {
      const text = [
        'setInterval(f, 1)',
        'function tick() {',
        '  setTimeout(tick, 5)',
        '}',
        'const poll = () => {',
        '  setTimeout(() => void poll(), 5)',
        '}',
        'class A {',
        '  tick() {',
        '    setTimeout(() => this.tick(), 5)',
        '  }',
        '}',
      ].join('\n')
      expect(countSourceFile('src/main/timers.ts', text)).toEqual({ 'FF-14': 4 })
      expect(countSourceFile('src/main/timers-member.ts', 'globalThis.setInterval(f, 1)\n')).toEqual({ 'FF-14': 1 })
      expect(countSourceFile('src/main/timers-field.ts', [
        'class A {',
        '  poll = () => {',
        '    setTimeout(() => this.poll(), 5)',
        '  }',
        '}',
      ].join('\n'))).toEqual({ 'FF-14': 1 })
      expect(countSourceFile('src/main/timers-false-positive.ts', [
        'class A {',
        '  tick() {',
        '    setTimeout(() => obj.tick(), 5)',
        '  }',
        '}',
      ].join('\n'))).toEqual({})
      expect(countSourceFile('src/main/oneshot.ts', 'setTimeout(done, 5)\n')).toEqual({})
      expect(countSourceFile('src/main/infra/scheduler/timers.ts', text)).toEqual({})
      expect(countSourceFile('src/renderer/src/timers.ts', text)).toEqual({})
    })
  })
})

describe('architecture layering dependency-cruiser gate', () => {
  it('reports the exact module-graph violations for architecture fitness functions FF-01 through FF-03', () => {
    const fixture = createLayeringFixture()
    try {
      const result = runDependencyCruiser(fixture.root, 'json')
      expect(result.code, result.out).toBe(0)
      expect(sortedViolationLines(result.out)).toEqual([
        'ff01-contracts-import-beyond-zod error src/shared/contracts/schema.ts',
        'ff01-feature-imports-feature-internals error src/main/features/a/use-b.ts',
        'ff01-infra-imports-features error src/main/infra/x.ts',
        'ff01-renderer-imports-main-or-preload error src/renderer/src/main.tsx',
        'ff01-renderer-imports-main-or-preload-in-tests warn src/renderer/src/cross.test.ts',
        'ff02-import-cycle warn src/cycle/a.ts',
        'ff03-unreachable-from-entry-points warn src/dead.ts',
      ])
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('fails the default CLI on error violations and passes once only warnings remain', () => {
    const fixture = createLayeringFixture()
    try {
      const withErrors = runDependencyCruiser(fixture.root, 'default')
      expect(withErrors.code, withErrors.out).not.toBe(0)

      removeLayeringErrors(fixture.root)

      const warnOnly = runDependencyCruiser(fixture.root, 'default')
      expect(warnOnly.code, warnOnly.out).toBe(0)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })
})

describe('architecture ratchet CLI', () => {
  it('with no baseline file: exits 1, stdout ends with a seed whose parsed JSON has at least one entry each under FF-02, FF-03, FF-04 and FF-05a for this fixture', () => {
    const fixture = createArchitectureFixture()
    try {
      const result = runArchitectureCli(fixture.root)
      expect(result.code, result.out).toBe(1)

      const seed = readTrailingJson(result.out)
      expect(Object.keys(seed['FF-02'] ?? {}).length).toBeGreaterThan(0)
      expect(Object.keys(seed['FF-03'] ?? {}).length).toBeGreaterThan(0)
      expect(Object.keys(seed['FF-04'] ?? {}).length).toBeGreaterThan(0)
      expect(Object.keys(seed['FF-05a'] ?? {}).length).toBeGreaterThan(0)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it("with that seed written as the baseline: exits 0, output contains 'OK:'", () => {
    const fixture = createArchitectureFixture()
    try {
      const seed = readTrailingJson(runArchitectureCli(fixture.root).out)
      writeFixtureFile(fixture.root, 'scripts/architecture-baseline.json', formatBaseline(seed))

      const result = runArchitectureCli(fixture.root)
      expect(result.code, result.out).toBe(0)
      expect(result.out).toContain('OK:')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it("adding a new non-test source file over 800 lines under src/main: exits 1 with a line naming FF-04 and '0 -> 801'", () => {
    const fixture = createArchitectureFixture()
    try {
      const seed = readTrailingJson(runArchitectureCli(fixture.root).out)
      writeFixtureFile(fixture.root, 'scripts/architecture-baseline.json', formatBaseline(seed))

      writeFixtureFile(
        fixture.root,
        'src/main/new-long.ts',
        `${Array.from({ length: 801 }, (_, index) => `export const line${index + 1} = ${index + 1}`).join('\n')}\n`,
      )

      const result = runArchitectureCli(fixture.root)
      expect(result.code, result.out).toBe(1)
      expect(result.out).toContain('FF-04 src/main/new-long.ts: 0 -> 801 (rose')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it.each([
    ['operator/src/new-long', 'ts'],
    ['intelligence/src/new-long', 'tsx'],
    ['scripts/new-long', 'mjs'],
  ])('adding an 801-line production file %s: exits 1 naming FF-04 and 0 -> 801', (stem, extension) => {
    const fixture = createArchitectureFixture()
    try {
      const seed = readTrailingJson(runArchitectureCli(fixture.root).out)
      writeFixtureFile(fixture.root, 'scripts/architecture-baseline.json', formatBaseline(seed))

      writeFixtureFile(
        fixture.root,
        `${stem}.${extension}`,
        `${Array.from({ length: 801 }, (_, index) => `export const line${index + 1} = ${index + 1}`).join('\n')}\n`,
      )

      const result = runArchitectureCli(fixture.root)
      expect(result.code, result.out).toBe(1)
      expect(result.out).toContain(`FF-04 ${stem}.${extension}: 0 -> 801 (rose`)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it("adding one import that creates a new cycle: exits 1 with a line naming FF-02 and '0 -> 1', no JSON printed because nothing fell", () => {
    const fixture = createArchitectureFixture()
    try {
      const seed = readTrailingJson(runArchitectureCli(fixture.root).out)
      writeFixtureFile(fixture.root, 'scripts/architecture-baseline.json', formatBaseline(seed))

      writeFixtureFile(fixture.root, 'src/new-cycle/b.ts', [
        "import './a'",
        'export const newCycleB = true',
      ].join('\n'))

      const result = runArchitectureCli(fixture.root)
      expect(result.code, result.out).toBe(1)
      expect(result.out).toMatch(/FF-02 src\/new-cycle\/[ab]\.ts: 0 -> 1 \(rose/)
      expect(result.out).not.toContain('"FF-01":')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it("deleting the dead file: exits 1, the FF-03 line reads '1 -> 0 (fell', and the printed JSON parses, lacks that file, and equals the seed minus that entry", () => {
    const fixture = createArchitectureFixture()
    try {
      const seed = readTrailingJson(runArchitectureCli(fixture.root).out)
      writeFixtureFile(fixture.root, 'scripts/architecture-baseline.json', formatBaseline(seed))

      rmSync(join(fixture.root, 'src', 'dead.ts'))

      const result = runArchitectureCli(fixture.root)
      expect(result.code, result.out).toBe(1)
      expect(result.out).toContain('FF-03 src/dead.ts: 1 -> 0 (fell')

      const expected = JSON.parse(JSON.stringify(seed)) as Counts
      delete expected['FF-03']['src/dead.ts']
      const lowered = readTrailingJson(result.out)
      expect(lowered['FF-03']).not.toHaveProperty('src/dead.ts')
      expect(lowered).toEqual(expected)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it("reordering two keys of a valid baseline: exits 1 'not canonical'", () => {
    const fixture = createArchitectureFixture()
    try {
      const seed = readTrailingJson(runArchitectureCli(fixture.root).out)
      const reordered = {
        'FF-02': seed['FF-02'],
        'FF-01': seed['FF-01'],
        ...Object.fromEntries(RULE_IDS.slice(2).map((rule) => [rule, seed[rule]])),
      }
      writeFixtureFile(fixture.root, 'scripts/architecture-baseline.json', `${JSON.stringify(reordered, null, 2)}\n`)

      const result = runArchitectureCli(fixture.root)
      expect(result.code, result.out).toBe(1)
      expect(result.out).toContain('not canonical')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('a baseline file that is valid JSON but not an object: exits 1 with only the real error, no unrelated skeleton', () => {
    const fixture = createArchitectureFixture()
    try {
      writeFixtureFile(fixture.root, 'scripts/architecture-baseline.json', 'null\n')

      const result = runArchitectureCli(fixture.root)
      expect(result.code, result.out).toBe(1)
      expect(result.out).toContain('not canonical')
      expect(result.out).not.toContain('"FF-01": {}')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })
})

describe('build.yml Architecture ratchet step is blocking (M2-0237)', () => {
  function architectureRatchetStepBlock(): string {
    const workflow = readFileSync(join(__dirname, '..', '.github', 'workflows', 'build.yml'), 'utf8')
    const marker = workflow.indexOf('\n      - name: Architecture ratchet\n')
    expect(marker, 'Architecture ratchet step not found in build.yml').toBeGreaterThan(-1)
    const nextStep = workflow.indexOf('\n      - name:', marker + 1)
    return nextStep === -1 ? workflow.slice(marker) : workflow.slice(marker, nextStep)
  }

  it('has no continue-on-error, so a differing count fails the job instead of only being reported', () => {
    expect(architectureRatchetStepBlock()).not.toContain('continue-on-error')
  })

  it('still runs check:architecture', () => {
    expect(architectureRatchetStepBlock()).toContain('run: npm run check:architecture')
  })
})
