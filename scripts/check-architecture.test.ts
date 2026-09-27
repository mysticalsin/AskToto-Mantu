import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as architecture from './check-architecture.mjs'

type Counts = Record<string, Record<string, number>>
type Difference = { rule: string; file: string; baseline: number; current: number }
type ArchitectureModule = {
  countSourceFile: (file: string, text: string) => Record<string, number>
  countDependencyViolations: (violations: Array<{ rule: { name: string }; from: string }>) => Counts
  compareCounts: (baseline: Counts, current: Counts) => { regressions: Difference[]; stale: Difference[] }
  lowerBaseline: (baseline: Counts, current: Counts) => Counts
  formatBaseline: (counts: Counts) => string
}

const {
  compareCounts,
  countDependencyViolations,
  countSourceFile,
  formatBaseline,
  lowerBaseline,
} = architecture as unknown as ArchitectureModule

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

const DEPENDENCY_CRUISER_CONFIG = `/**
 * Architecture fitness functions FF-01..FF-03: the rules that need the resolved module graph.
 * Every rule name starts with its fitness-function id (\`ff01-\`, \`ff02-\`, \`ff03-\`).
 */
const TEST_FILE = '\\\\.(test|spec)\\\\.tsx?$'
const ENTRY_POINTS = [
  '^src/main/(index|parakeet-asr-host|parakeet-extract-host|speaker-embedding-host|whisper-asr-host)\\\\.ts$',
  '^src/preload/(index|intelligence|import-decoder)\\\\.ts$',
  '^src/renderer/src/(main\\\\.tsx|import-decoder\\\\.ts)$',
  '^src/renderer/src/lib/whisper\\\\.worker\\\\.ts$',
]
function boundary(name, comment, fromPath, to) {
  return [
    { name: \`ff01-\${name}\`, comment, severity: 'error', from: { path: fromPath, pathNot: TEST_FILE }, to },
    { name: \`ff01-\${name}-in-tests\`, comment, severity: 'warn', from: { path: \`\${fromPath}.*\${TEST_FILE}\` }, to },
  ]
}
module.exports = {
  forbidden: [
    ...boundary('renderer-imports-main-or-preload',
      'The renderer reaches main only through the preload bridge and src/shared.',
      '^src/renderer/', { path: '^src/(main|preload)/' }),
    ...boundary('preload-imports-main-or-renderer',
      'The preload bundle imports only src/shared, Electron and Node.',
      '^src/preload/', { path: '^src/(main|renderer)/' }),
    ...boundary('main-imports-renderer-or-preload',
      'The main bundle never contains renderer or preload code.',
      '^src/main/', { path: '^src/(renderer|preload)/' }),
    ...boundary('shared-imports-a-process',
      'src/shared is imported by every process, so it imports none of them.',
      '^src/shared/', { path: '^src/(main|renderer|preload)/' }),
    ...boundary('infra-imports-features',
      'Features depend on infrastructure, never the reverse.',
      '^src/main/infra/', { path: '^src/main/features/' }),
    ...boundary('feature-imports-feature-internals',
      'Another feature is reached only through its index.ts.',
      '^src/main/features/([^/]+)/',
      { path: '^src/main/features/[^/]+/', pathNot: ['^src/main/features/$1/', '^src/main/features/[^/]+/index\\\\.ts$'] }),
    {
      name: 'ff01-contracts-import-beyond-zod',
      comment: 'Contracts are plain zod schemas: they import zod and each other, nothing else.',
      severity: 'error',
      from: { path: '^src/shared/contracts/', pathNot: TEST_FILE },
      to: { pathNot: ['^src/shared/contracts/', '(^|/)node_modules/zod/'] },
    },
    {
      name: 'ff02-import-cycle',
      comment: 'Every module on a cycle loads, tests and changes together with all the others.',
      severity: 'warn',
      from: { path: '^src/' },
      to: { circular: true },
    },
    {
      name: 'ff03-unreachable-from-entry-points',
      comment: 'No entry point reaches this module, so it is dead code (being imported by a test does not count).',
      severity: 'warn',
      from: { path: ENTRY_POINTS },
      to: { path: '^src/.+\\\\.tsx?$', pathNot: [TEST_FILE, '\\\\.d\\\\.ts$', '/__fixtures__/', ...ENTRY_POINTS], reachable: false },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.web.json' },
  },
}
`

function sortedViolationLines(stdout: string): string[] {
  const report = JSON.parse(stdout) as {
    violations: Array<{ rule: { name: string; severity: string }; from: string }>
  }
  return report.violations
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

function createLayeringFixture(): { root: string; fixtureNodeModules: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'metis-architecture-')))
  const fixtureNodeModules = join(root, 'node_modules')
  symlinkSync(
    join(__dirname, '..', 'node_modules'),
    fixtureNodeModules,
    process.platform === 'win32' ? 'junction' : 'dir',
  )

  writeFixtureFile(root, '.dependency-cruiser.cjs', DEPENDENCY_CRUISER_CONFIG)
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
    "import '../../../main/service'",
    'export const rendererEntry = true',
  ].join('\n'))
  writeFixtureFile(root, 'src/renderer/src/cross.test.ts', [
    "import '../../../main/service'",
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
  writeFixtureFile(root, 'src/shared/alias-target.ts', 'export const sharedAlias = true\n')
  writeFixtureFile(root, 'src/alias-root.ts', 'export const rootAlias = true\n')
  writeFixtureFile(root, 'src/renderer/src/lib/whisper.worker.ts', 'export const workerEntry = true\n')

  return { root, fixtureNodeModules }
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
      { rule: { name: 'ff05a-sync-fs' }, from: 'src/main/a.ts' },
      { rule: { name: 'ff05b-meeting-root-fs' }, from: 'src/main/brain/store.ts' },
    ])).toEqual({
      'FF-01': { 'src/renderer/src/main.tsx': 2 },
      'FF-02': { 'src/cycle/a.ts': 1 },
      'FF-03': { 'src/dead.ts': 1 },
      'FF-05a': { 'src/main/a.ts': 1 },
      'FF-05b': { 'src/main/brain/store.ts': 1 },
    })
    expect(() => countDependencyViolations([
      { rule: { name: 'layering-renderer-imports-main' }, from: 'src/renderer/src/main.tsx' },
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
      ].join('\n'))).toEqual({ 'FF-05a': 4 })
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
        "readFileSync('__fixtures__/a.ts', 'utf8')",
        "readFileSync('types.d.ts', 'utf8')",
        "const prose = 'the index.ts file'",
      ].join('\n'))).toEqual({})
      expect(countSourceFile('scripts/check.test.ts', [
        "const source = 'index.ts'",
        'void source',
      ].join('\n'))).toEqual({})
      expect(countSourceFile('src/main/x.ts', [
        "import { readFileSync } from 'node:fs'",
        "readFileSync('index.ts', 'utf8')",
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
      expect(countSourceFile('src/main/infra/process/spawn.ts', text)).toEqual({})
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
      expect(fixture.fixtureNodeModules).toBe(join(fixture.root, 'node_modules'))
      const result = runDependencyCruiser(fixture.root, 'json')
      expect(result.code, result.out).toBe(0)
      expect(sortedViolationLines(result.out)).toEqual([
        'ff01-contracts-import-beyond-zod error src/shared/contracts/schema.ts',
        'ff01-feature-imports-feature-internals error src/main/features/a/use-b.ts',
        'ff01-infra-imports-features error src/main/infra/x.ts',
        'ff01-renderer-imports-main-or-preload error src/renderer/src/main.tsx',
        'ff01-renderer-imports-main-or-preload-in-tests warn src/renderer/src/cross.test.ts',
        'ff02-import-cycle warn src/cycle/a.ts',
        'ff02-import-cycle warn src/cycle/b.ts',
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
  it.todo('with no baseline file: exits 1, stdout ends with a seed whose parsed JSON has at least one entry each under FF-02, FF-03, FF-04 and FF-05a for this fixture')
  it.todo("with that seed written as the baseline: exits 0, output contains 'OK:'")
  it.todo("adding one import that creates a new cycle: exits 1 with a line naming FF-02 and '0 -> 1', no JSON printed because nothing fell")
  it.todo("deleting the dead file: exits 1, the FF-03 line reads '1 -> 0 (fell', and the printed JSON parses, lacks that file, and equals the seed minus that entry")
  it.todo("reordering two keys of a valid baseline: exits 1 'not canonical'")
})
