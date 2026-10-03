import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { claimProblems, HOT_UNITS, MAX_MAIN_PROCESS_CLAIMS } from './claims-check.mjs'

const SCRIPT = fileURLToPath(new URL('./claims-check.mjs', import.meta.url))

function ticket(id, status, scope_paths) {
  return { id, status, scope_paths }
}

function problemsFor(...tickets) {
  return claimProblems({ tickets })
}

function conflict(a, b) {
  return problemsFor(ticket('M2-9001', 'IN_PROGRESS', [a]), ticket('M2-9002', 'IN_PROGRESS', [b]))
}

test('exports the hot units and the main-process limit', () => {
  assert.equal(MAX_MAIN_PROCESS_CLAIMS, 3)
  assert.deepEqual(Object.keys(HOT_UNITS), ['index', 'app', 'ipc', 'preload', 'deps', 'release-wf', 'build-wf', 'helper'])
})

test('two IN_PROGRESS tickets on one unit give one line naming the unit and both tickets', () => {
  const problems = conflict('src/shared/ipc.ts', 'src/shared/ipc.ts')
  assert.equal(problems.length, 1)
  assert.match(problems[0], /^M2-9001, M2-9002: /)
  assert.match(problems[0], /ipc/)
})

test('no conflict when the other side is TODO, ENGINEERING_COMPLETE or DONE', () => {
  for (const status of ['TODO', 'ENGINEERING_COMPLETE', 'DONE']) {
    const problems = problemsFor(
      ticket('M2-9001', 'IN_PROGRESS', ['src/shared/ipc.ts']),
      ticket('M2-9002', status, ['src/shared/ipc.ts'])
    )
    assert.deepEqual(problems, [], status)
  }
})

test('a directory claim covers the unit under it and the reverse', () => {
  assert.equal(conflict('native/mac-helper/', 'native/mac-helper/main.swift').length, 1)
  assert.equal(conflict('src/preload/a.ts', 'src/preload/b.ts').length, 1)
})

test('package.json and package-lock.json are one unit', () => {
  assert.equal(conflict('package.json', 'package-lock.json').length, 1)
})

test('release.yml and build.yml are separate units; the workflows directory covers build.yml', () => {
  assert.deepEqual(conflict('.github/workflows/release.yml', '.github/workflows/build.yml'), [])
  assert.equal(conflict('.github/workflows/', '.github/workflows/build.yml').length, 1)
})

test('a glob claim matches within one path segment only', () => {
  assert.equal(conflict('src/shared/*.ts', 'src/shared/ipc.ts').length, 1)
  assert.deepEqual(conflict('src/*.ts', 'src/shared/ipc.ts'), [])
})

test('prefix traps do not match', () => {
  assert.deepEqual(conflict('src/main/index.tsx', 'src/main/index.ts'), [])
  assert.deepEqual(conflict('src/preload-x/a.ts', 'src/preload/b.ts'), [])
  const mainline = ['M2-9001', 'M2-9002', 'M2-9003', 'M2-9004'].map((id) => ticket(id, 'IN_PROGRESS', ['src/mainline.ts']))
  assert.deepEqual(problemsFor(...mainline), [])
})

test('three src/main tickets pass and four fail', () => {
  const claims = (n) =>
    ['M2-9001', 'M2-9002', 'M2-9003', 'M2-9004'].slice(0, n).map((id) => ticket(id, 'IN_PROGRESS', [`src/main/${id}.ts`]))
  assert.deepEqual(problemsFor(...claims(3)), [])
  const problems = problemsFor(...claims(4))
  assert.equal(problems.length, 1)
  assert.match(problems[0], /^M2-9001, M2-9002, M2-9003, M2-9004: /)
})

test('a directory claim containing src/main counts toward the main-process limit', () => {
  const tickets = ['M2-9001', 'M2-9002', 'M2-9003'].map((id) => ticket(id, 'IN_PROGRESS', [`src/main/${id}.ts`]))
  tickets.push(ticket('M2-9004', 'IN_PROGRESS', ['src/']))
  assert.equal(problemsFor(...tickets).length, 1)
})

test('the ledger path is a hot unit only when given', () => {
  const tickets = [ticket('M2-9001', 'IN_PROGRESS', ['ledger/tickets.json']), ticket('M2-9002', 'IN_PROGRESS', ['./ledger/tickets.json'])]
  assert.deepEqual(claimProblems({ tickets }), [])
  const problems = claimProblems({ tickets }, { ledgerPath: 'ledger/tickets.json' })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /^M2-9001, M2-9002: /)
})

test('a malformed scope_paths on an IN_PROGRESS ticket is a problem; on other statuses it is ignored', () => {
  for (const bad of [undefined, 'src/main/', ['src/main/', 3]]) {
    const problems = problemsFor(ticket('M2-9001', 'IN_PROGRESS', bad))
    assert.equal(problems.length, 1)
    assert.match(problems[0], /^M2-9001: /)
  }
  assert.deepEqual(problemsFor(ticket('M2-9001', 'TODO', 'nope')), [])
})

test('a ledger without a tickets array is a problem', () => {
  assert.equal(claimProblems({}).length, 1)
})

function runScript(args, ledgerJson) {
  const dir = mkdtempSync(join(tmpdir(), 'metis-claims-'))
  try {
    const ledger = join(dir, 'tickets.json')
    if (ledgerJson !== undefined) writeFileSync(ledger, ledgerJson)
    const argv = args.map((arg) => (arg === '<ledger>' ? ledger : arg))
    return spawnSync(process.execPath, [SCRIPT, ...argv], { encoding: 'utf8' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('CLI exits 0 for no problems, 1 for problems and 2 for usage or read errors', () => {
  const ok = JSON.stringify({ tickets: [ticket('M2-9001', 'IN_PROGRESS', ['src/shared/ipc.ts'])] })
  const bad = JSON.stringify({
    tickets: [ticket('M2-9001', 'IN_PROGRESS', ['src/shared/ipc.ts']), ticket('M2-9002', 'IN_PROGRESS', ['src/shared/ipc.ts'])]
  })
  assert.equal(runScript(['--ledger', '<ledger>'], ok).status, 0)
  const failing = runScript(['--ledger', '<ledger>'], bad)
  assert.equal(failing.status, 1)
  assert.match(failing.stderr, /M2-9001, M2-9002/)
  assert.equal(runScript([], ok).status, 2)
  assert.equal(runScript(['--bogus'], ok).status, 2)
  assert.equal(runScript(['--ledger', '<ledger>'], undefined).status, 2)
  assert.equal(runScript(['--ledger', '<ledger>'], '{not json').status, 2)
})
