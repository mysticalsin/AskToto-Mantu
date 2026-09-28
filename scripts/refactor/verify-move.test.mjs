import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  compareMultisets,
  normalizeImportPaths,
  parseNameStatus,
  tokenMultiset,
  verifyPureMove
} from './verify-move.mjs'
import { refactorClassification } from './check-pr-classification.mjs'

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
  }), { ok: true, modifiedProblems: [], unsupported: [], tokenProblems: [] })
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
