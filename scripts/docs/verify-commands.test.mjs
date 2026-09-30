import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkLinks, extractTargets } from './check-links.mjs'
import { extractBlocks, requiredFiles, unmarkedFiles, verifyBlocks } from './verify-commands.mjs'

const files = new Set(['package.json', 'scripts/a.mjs', 'tsconfig.node.json', 'src/x.test.ts', 'operator', 'operator/package.json'])
const packages = {
  'package.json': {
    scripts: { typecheck: 'tsc', test: 'vitest', 'check:x': 'node scripts/a.mjs', dev: 'x', build: 'x', 'dist:win': 'x', installers: 'x' }
  },
  'operator/package.json': { scripts: { smoke: 'node s.mjs' } }
}
const tree = { exists: (path) => files.has(path), readJson: (path) => packages[path] ?? null }
const neverRun = () => assert.fail('a dry-run block must not execute anything')

const block = (mode, ...commands) => ({ file: 'README.md', line: 1, mode, commands })
const outcome = (blocks, run = neverRun) => verifyBlocks(blocks, { tree, run }).map((r) => r.status)

test('extractBlocks keeps only marked blocks and normalises continuations, comments and prompts', () => {
  const md = [
    '```bash',
    'npm run unmarked',
    '```',
    '```bash verify-dry',
    '$ npm run typecheck    # tsc, both projects',
    '# a comment line',
    'node scripts/a.mjs \\',
    '  --flag',
    '```',
    '  ```sh verify',
    'npm run check:x',
    '  ```'
  ].join('\n')
  assert.deepEqual(extractBlocks(md, 'F.md'), [
    { file: 'F.md', line: 4, mode: 'verify-dry', commands: ['npm run typecheck', 'node scripts/a.mjs --flag'] },
    { file: 'F.md', line: 10, mode: 'verify', commands: ['npm run check:x'] }
  ])
})

test('dry-run resolves scripts, files and configs against the tree and never executes', () => {
  const good = block('verify-dry', 'npm ci', 'npm test', 'npm run typecheck', 'node scripts/a.mjs --x', 'npx tsc --noEmit -p tsconfig.node.json', 'npx vitest run src/x.test.ts', 'gh run view 1')
  assert.deepEqual(outcome([good]), Array(7).fill('PASS'))
})

test('a script, file or config the commit lacks fails, and so does a command the verifier does not know', () => {
  const bad = block('verify-dry', 'npm run nope', 'node scripts/gone.mjs', 'npx tsc --noEmit -p gone.json', 'npx vitest run src/gone.test.ts', 'curl https://example.com', 'npm publish')
  assert.deepEqual(outcome([bad]), Array(6).fill('FAIL'))
})

test('cd moves later commands of the same block into that directory only', () => {
  assert.deepEqual(outcome([block('verify-dry', 'cd operator', 'npm run smoke')]), ['PASS', 'PASS'])
  assert.deepEqual(outcome([block('verify-dry', 'cd operator', 'npm run typecheck')]), ['PASS', 'FAIL'])
  assert.deepEqual(outcome([block('verify-dry', 'npm run smoke')]), ['FAIL'])
})

test('verify executes in the checkout and reports the exit code', () => {
  const ran = []
  const run = (command, cwd) => (ran.push([command, cwd]), { status: command.includes('a.mjs') ? 1 : 0, output: 'boom' })
  const results = verifyBlocks([block('verify', 'cd operator', 'npm run smoke'), block('verify', 'node scripts/a.mjs')], { tree, run })
  assert.deepEqual(ran, [['npm run smoke', 'operator'], ['node scripts/a.mjs', '']])
  assert.equal(results[1].status, 'PASS')
  assert.equal(results[2].status, 'FAIL')
  assert.match(results[2].detail, /exit/)
})

test('a side-effecting command marked verify fails without executing', () => {
  const risky = ['npm ci', 'npm test', 'npm run dev', 'npm run dist:win', 'npm run build', 'npm run installers', 'npx vitest run src/x.test.ts']
  assert.deepEqual(outcome([block('verify', ...risky)]), Array(risky.length).fill('FAIL'))
})

test('a file with no marked block is reported so marking nothing cannot pass', () => {
  const blocks = [{ file: 'README.md' }]
  assert.deepEqual(unmarkedFiles(['README.md', 'AGENTS.md'], blocks), ['AGENTS.md'])
})

test('requiredFiles lists README, AGENTS and every runbook in this repository', () => {
  const list = requiredFiles(join(import.meta.dirname, '..', '..'))
  assert.deepEqual(list.slice(0, 2), ['README.md', 'AGENTS.md'])
  assert.ok(list.length > 2 && list.slice(2).every((f) => f.startsWith('docs/runbooks/') && f.endsWith('.md')))
})

test('extractTargets ignores code, external links and anchors', () => {
  const md = ['[a](docs/a.md) [b](https://x.io) [c](#top) `[d](docs/d.md)` <img src="m/p.png">', '```', '[e](docs/e.md)', '```'].join('\n')
  assert.deepEqual(extractTargets(md), ['docs/a.md', 'm/p.png'])
})

test('checkLinks reports only relative links that do not resolve', () => {
  const root = mkdtempSync(join(tmpdir(), 'docs-links-'))
  mkdirSync(join(root, 'docs', 'sub'), { recursive: true })
  writeFileSync(join(root, 'docs', 'real.md'), '# real\n')
  writeFileSync(join(root, 'AGENTS.md'), '[ok](docs/real.md#h)\n')
  writeFileSync(join(root, 'README.md'), '[gone](docs/gone.md) [dir](docs/sub)\n')
  writeFileSync(join(root, 'docs', 'sub', 'n.md'), '[up](../real.md) [bad](../missing.md)\n')
  assert.deepEqual(checkLinks(root), [
    { file: 'README.md', target: 'docs/gone.md' },
    { file: 'docs/sub/n.md', target: '../missing.md' }
  ])
})

test('the CLI refuses a commit that is not the checked-out one', () => {
  const root = mkdtempSync(join(tmpdir(), 'docs-verify-'))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  git('init', '-q')
  git('-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'one')
  const first = git('rev-parse', 'HEAD')
  git('-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'two')
  const cli = join(import.meta.dirname, 'verify-commands.mjs')
  assert.throws(() => execFileSync(process.execPath, [cli, '--commit', first, '--root', root], { stdio: 'pipe' }), (error) => error.status === 2)
})

test('this repository: every relative doc link resolves', () => {
  assert.deepEqual(checkLinks(), [])
})

test('this repository: every marked command in README, AGENTS and the runbooks resolves in the working tree', () => {
  const root = join(import.meta.dirname, '..', '..')
  const list = requiredFiles(root)
  const blocks = list.flatMap((file) => extractBlocks(readFileSync(join(root, file), 'utf8'), file))
  assert.deepEqual(unmarkedFiles(list, blocks), [])
  const fsTree = {
    exists: (path) => existsSync(join(root, path)),
    readJson: (path) => (existsSync(join(root, path)) ? JSON.parse(readFileSync(join(root, path), 'utf8')) : null)
  }
  const dry = blocks.map((b) => ({ ...b, mode: 'verify-dry' }))
  const failures = verifyBlocks(dry, { tree: fsTree, run: neverRun }).filter((r) => r.status === 'FAIL')
  assert.deepEqual(failures, [])
})
