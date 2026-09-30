import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  compareMultisets,
  normalizeImportPaths,
  normalizedTokenSequence,
  parseNameStatus,
  tokenMultiset,
  verifyPureMove
} from './verify-move.mjs'
import { refactorClassification } from './check-pr-classification.mjs'
import { checkPrKind } from './check-pr-kind.mjs'
import { compareInventories, countGuardCalls, countTestCases, parseRemovals } from './guard-test-inventory.mjs'

test('normalizes only module specifiers that are import paths', () => {
  const source = [
    "import value from '../old/path'",
    "export { value } from './old-export'",
    "const lazy = import('../lazy')",
    "const loaded = require('../required')",
    "const message = '../not-an-import'"
  ].join('\n')

  assert.equal(normalizeImportPaths(source), [
    "import value from '__IMPORT_PATH__'",
    "export { value } from '__IMPORT_PATH__'",
    "const lazy = import('__IMPORT_PATH__')",
    "const loaded = require('__IMPORT_PATH__')",
    "const message = '../not-an-import'"
  ].join('\n'))
})

test('accepts moved code when only import paths change', () => {
  const entries = [
    { status: 'D', code: 'D', path: 'src/old/thing.ts' },
    { status: 'A', code: 'A', path: 'src/new/thing.ts' },
    { status: 'M', code: 'M', path: 'src/index.ts' }
  ]
  const contents = new Map([
    ['base:src/old/thing.ts', "import { helper } from '../helper'\nexport const answer = helper(41) + 1\n"],
    ['head:src/new/thing.ts', "import { helper } from '../../helper'\nexport const answer = helper(41) + 1\n"],
    ['base:src/index.ts', "export { answer } from './old/thing'\n"],
    ['head:src/index.ts', "export { answer } from './new/thing'\n"]
  ])

  assert.deepEqual(verifyPureMove({
    entries,
    readAtRevision: (side, path) => contents.get(`${side}:${path}`)
  }), { ok: true, modifiedProblems: [], orderProblems: [], unsupported: [], tokenProblems: [] })
})

test('rejects a behavior edit hidden inside a moved file', () => {
  const entries = [
    { status: 'D', code: 'D', path: 'src/old/thing.ts' },
    { status: 'A', code: 'A', path: 'src/new/thing.ts' }
  ]
  const contents = new Map([
    ['base:src/old/thing.ts', 'export const answer = 42\n'],
    ['head:src/new/thing.ts', 'export const answer = 43\n']
  ])

  const result = verifyPureMove({
    entries,
    readAtRevision: (side, path) => contents.get(`${side}:${path}`)
  })

  assert.equal(result.ok, false)
  assert.deepEqual(result.tokenProblems, [
    { token: '42', removed: 1, added: 0 },
    { token: '43', removed: 0, added: 1 }
  ])
})

test('rejects a same-token behavior edit hidden inside a moved file', () => {
  const entries = [
    { status: 'D', code: 'D', path: 'src/old/math.ts' },
    { status: 'A', code: 'A', path: 'src/new/math.ts' }
  ]
  const contents = new Map([
    ['base:src/old/math.ts', 'export function diff(a, b) {\n  return a - b\n}\n'],
    ['head:src/new/math.ts', 'export function diff(a, b) {\n  return b - a\n}\n']
  ])

  const result = verifyPureMove({
    entries,
    readAtRevision: (side, path) => contents.get(`${side}:${path}`)
  })

  assert.equal(result.ok, false)
  assert.deepEqual(result.tokenProblems, [])
  assert.deepEqual(result.orderProblems, [
    {
      removedPath: 'src/old/math.ts',
      addedPath: 'src/new/math.ts'
    }
  ])
})

test('rejects behavior edits to string literals containing comment markers', () => {
  const entries = [
    { status: 'D', code: 'D', path: 'src/old/endpoint.ts' },
    { status: 'A', code: 'A', path: 'src/new/endpoint.ts' }
  ]
  const contents = new Map([
    ['base:src/old/endpoint.ts', 'export const endpoint = "https://old.example/api"\n'],
    ['head:src/new/endpoint.ts', 'export const endpoint = "https://new.example/api"\n']
  ])

  const result = verifyPureMove({
    entries,
    readAtRevision: (side, path) => contents.get(`${side}:${path}`)
  })

  assert.equal(result.ok, false)
  assert.deepEqual(result.tokenProblems, [
    { token: '"https://new.example/api"', removed: 0, added: 1 },
    { token: '"https://old.example/api"', removed: 1, added: 0 }
  ])
})

test('rejects same-token behavior edits redistributed across moved files', () => {
  const entries = [
    { status: 'D', code: 'D', path: 'src/old/subtract.ts' },
    { status: 'D', code: 'D', path: 'src/old/add.ts' },
    { status: 'A', code: 'A', path: 'src/new/subtract.ts' },
    { status: 'A', code: 'A', path: 'src/new/add.ts' }
  ]
  const contents = new Map([
    ['base:src/old/subtract.ts', 'export function left(a, b) {\n  return a - b\n}\n'],
    ['base:src/old/add.ts', 'export function right(c, d) {\n  return c + d\n}\n'],
    ['head:src/new/subtract.ts', 'export function left(b, c) {\n  return b - c\n}\n'],
    ['head:src/new/add.ts', 'export function right(a, d) {\n  return a + d\n}\n']
  ])

  const result = verifyPureMove({
    entries,
    readAtRevision: (side, path) => contents.get(`${side}:${path}`)
  })

  assert.equal(result.ok, false)
  assert.deepEqual(result.tokenProblems, [])
  assert.deepEqual(result.orderProblems, [
    {
      removedPath: 'src/old/subtract.ts',
      addedPath: null
    },
    {
      removedPath: 'src/old/add.ts',
      addedPath: null
    }
  ])
})

test('rejects non-import changes in modified files', () => {
  const entries = [{ status: 'M', code: 'M', path: 'src/index.ts' }]
  const contents = new Map([
    ['base:src/index.ts', "export { answer } from './old/thing'\nexport const name = 'old'\n"],
    ['head:src/index.ts', "export { answer } from './new/thing'\nexport const name = 'new'\n"]
  ])

  const result = verifyPureMove({
    entries,
    readAtRevision: (side, path) => contents.get(`${side}:${path}`)
  })

  assert.equal(result.ok, false)
  assert.deepEqual(result.modifiedProblems, ['src/index.ts'])
})

test('parses nul-delimited git name-status output including renames', () => {
  const output = ['R100', 'src/old.ts', 'src/new.ts', 'M', 'src/index.ts', ''].join('\0')
  assert.deepEqual(parseNameStatus(output), [
    { status: 'R100', code: 'R', oldPath: 'src/old.ts', newPath: 'src/new.ts' },
    { status: 'M', code: 'M', path: 'src/index.ts' }
  ])
})

test('token multiset ignores comments but preserves non-import string literals', () => {
  const left = tokenMultiset("import x from './a'\n// moved\nconst label = './a'\n")
  const right = tokenMultiset("import x from './b'\n/* moved */\nconst label = './a'\n")
  assert.deepEqual(compareMultisets(left, right), [])
})

test('token multiset reads regex literals as code, not as comments or strings', () => {
  const before = normalizedTokenSequence(String.raw`const r = /a\/\//; const q = /"/; run(1)`)
  const after = normalizedTokenSequence(String.raw`const r = /a\/\//; const q = /"/; run(2)`)
  assert.notDeepEqual(before, after)
  assert.deepEqual(normalizedTokenSequence('const d = a / b / c'), ['const', 'd', '=', 'a', '/', 'b', '/', 'c'])
})

test('token multiset preserves string literals that contain comment markers', () => {
  const left = tokenMultiset('export const endpoint = "https://old.example/api" // old endpoint\n')
  const right = tokenMultiset('export const endpoint = "https://new.example/api" // new endpoint\n')

  assert.deepEqual(compareMultisets(left, right), [
    { token: '"https://new.example/api"', removed: 0, added: 1 },
    { token: '"https://old.example/api"', removed: 1, added: 0 }
  ])
})

test('CLI writes an artifact and fails when a pure move changes tokens', () => {
  const root = mkdtempSync(join(tmpdir(), 'verify-move-'))
  const repo = join(root, 'repo')
  mkdirSync(join(repo, 'scripts', 'refactor'), { recursive: true })
  mkdirSync(join(repo, 'src', 'old'), { recursive: true })
  mkdirSync(join(repo, 'src', 'new'), { recursive: true })
  writeFileSync(join(repo, 'scripts', 'refactor', 'verify-move.mjs'), readFileSync(new URL('./verify-move.mjs', import.meta.url)))
  writeFileSync(join(repo, 'src', 'old', 'thing.ts'), 'export const answer = 42\n')
  execFileSync('git', ['init'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo })
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'base'], { cwd: repo })
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  renameSync(join(repo, 'src', 'old', 'thing.ts'), join(repo, 'src', 'new', 'thing.ts'))
  writeFileSync(join(repo, 'src', 'new', 'thing.ts'), 'export const answer = 43\n')
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'head'], { cwd: repo })
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()

  assert.throws(
    () => execFileSync(process.execPath, ['scripts/refactor/verify-move.mjs', '--base', base, '--head', head], { cwd: repo }),
    /Pure-move verification failed/
  )
  const report = JSON.parse(readFileSync(join(repo, 'out', 'refactor', 'verify-move', 'verify-move.json'), 'utf8'))
  assert.equal(report.ok, false)
  assert.equal(report.token_differences.length, 2)
})

test('PR classification requires exactly one refactor type', () => {
  assert.deepEqual(refactorClassification('- [x] Pure move\n- [ ] Behaviour change\n'), {
    ok: true,
    type: 'pure-move',
    problems: []
  })
  assert.deepEqual(refactorClassification('- [ ] Pure move\n- [x] Behaviour change\n'), {
    ok: true,
    type: 'behaviour-change',
    problems: []
  })
  assert.equal(refactorClassification('- [x] Pure move\n- [x] Behaviour change\n').ok, false)
  assert.equal(refactorClassification('- [ ] Pure move\n- [ ] Behaviour change\n').ok, false)
})

const moveEntries = [
  { status: 'D', code: 'D', path: 'src/old/thing.ts' },
  { status: 'A', code: 'A', path: 'src/new/thing.ts' },
  { status: 'M', code: 'M', path: 'src/old/thing.test.ts' }
]
const bigBody = Array.from({ length: 60 }, (_, index) => `export const value${index} = ${index}`).join('\n')

function verifyWithTest(testBefore, testAfter) {
  const contents = new Map([
    ['base:src/old/thing.ts', 'export const answer = 42\n'],
    ['head:src/new/thing.ts', 'export const answer = 42\n'],
    ['base:src/old/thing.test.ts', testBefore],
    ['head:src/old/thing.test.ts', testAfter]
  ])
  return verifyPureMove({ entries: moveEntries, readAtRevision: (side, path) => contents.get(`${side}:${path}`) })
}

test('accepts a test string literal rewritten from the moved file old path to its new path', () => {
  assert.equal(verifyWithTest("read('src/old/thing.ts')\n", "read('src/new/thing.ts')\n").ok, true)
  assert.equal(verifyWithTest('load("src/old/thing")\n', 'load("src/new/thing")\n').ok, true)
})

test('rejects a test string literal rewritten to anything but the moved file new path', () => {
  const wrongTarget = verifyWithTest("read('src/old/thing.ts')\n", "read('src/other/thing.ts')\n")
  assert.equal(wrongTarget.ok, false)
  assert.deepEqual(wrongTarget.modifiedProblems, ['src/old/thing.test.ts'])
  assert.equal(verifyWithTest("read('src/old/other.ts')\n", "read('src/new/other.ts')\n").ok, false)
  assert.equal(verifyWithTest("read('src/old/thing.ts')\n", "read('src/new/thing.ts', 1)\n").ok, false)
})

function kindFixture(body, entries, contents) {
  return checkPrKind({ body, entries, readAtRevision: (side, path) => contents.get(`${side}:${path}`) ?? '' })
}

const sourceMapEdit = { status: 'M', code: 'M', path: 'docs/PLATFORM-MAP.md' }
const bigMove = [
  { status: 'D', code: 'D', path: 'src/old/big.ts' },
  { status: 'A', code: 'A', path: 'src/new/big.ts' }
]
const bigContents = new Map([['base:src/old/big.ts', bigBody], ['head:src/new/big.ts', bigBody]])

test('PR kind fails when the kind field is missing or both kinds are ticked', () => {
  assert.equal(kindFixture('no checklist', [], new Map()).ok, false)
  assert.equal(kindFixture('- [x] Pure move\n- [x] Behaviour change\n', [], new Map()).ok, false)
  assert.equal(kindFixture('- [ ] Pure move\n- [x] Behaviour change\n', [], new Map()).ok, true)
})

test('PR kind fails a behaviour change that carries a relocated block above the threshold', () => {
  const behaviour = '- [ ] Pure move\n- [x] Behaviour change\n'
  const result = kindFixture(behaviour, [...bigMove, sourceMapEdit], bigContents)
  assert.equal(result.ok, false)
  assert.match(result.problems[0], /relocates \d+ tokens/)

  const small = new Map([['base:src/old/big.ts', 'export const a = 1\n'], ['head:src/new/big.ts', 'export const a = 1\n']])
  assert.equal(kindFixture(behaviour, [...bigMove, sourceMapEdit], small).ok, true)
  assert.equal(kindFixture('- [x] Pure move\n- [ ] Behaviour change\n', [...bigMove, sourceMapEdit], bigContents).ok, true)
})

test('PR kind fails a refactor that moved files without touching the source map', () => {
  const pure = '- [x] Pure move\n- [ ] Behaviour change\n'
  const result = kindFixture(pure, bigMove, bigContents)
  assert.equal(result.ok, false)
  assert.match(result.problems[0], /source map/)
  assert.equal(kindFixture(pure, [...bigMove, sourceMapEdit], bigContents).ok, true)
})

test('inventory counts test cases and guard call sites but not guard definitions', () => {
  assert.equal(countTestCases("test('a', () => {})\nit.skip('b', () => {})\nconst latest = 1\nlatest('x')\n"), 2)
  const source = 'function assertMainWindow(e) {}\nassertMainWindow(e)\nif (denyIfLimited()) return\nobj.requireAuth()\n'
  assert.equal(countGuardCalls(source), 2)
})

test('inventory fails a drop unless each removal is listed with its replacement', () => {
  const base = { tests: 10, guards: 5 }
  const head = { tests: 9, guards: 4 }
  assert.equal(compareInventories({ base, head, body: '## Removed guards and tests\n' }).ok, false)
  assert.equal(compareInventories({ base, head, body: '## Removed guards and tests\n- a.test.ts case => b.test.ts case\n' }).ok, false)
  const listed = '## Removed guards and tests\n\n- a.test.ts case => b.test.ts case\n- old handler guard => shared registerHandler guard\n\n## Evidence\n'
  assert.equal(compareInventories({ base, head, body: listed }).ok, true)
  assert.equal(compareInventories({ base, head: base, body: '' }).ok, true)
  assert.equal(compareInventories({ base, head: { tests: 12, guards: 6 }, body: '' }).ok, true)
})

test('inventory ignores removals commented out in the template', () => {
  const body = '## Removed guards and tests\n<!--\n- example => example\n-->\n'
  assert.deepEqual(parseRemovals(body), [])
})
