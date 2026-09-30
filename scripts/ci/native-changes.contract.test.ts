import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')
const script = join(root, 'scripts', 'ci', 'native-changes.sh')
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8').replace(/\r\n/g, '\n')

/** The text of one top-level job, up to the next top-level job. */
function job(workflow: string, name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`)
  expect(start, `job not found: ${name}`).toBeGreaterThan(-1)
  const next = workflow.slice(start + 1).search(/\n {2}[a-z][a-z0-9-]*:\n/)
  return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next)
}

const canary = read('.github', 'workflows', 'isolation-canary.yml')
const build = read('.github', 'workflows', 'build.yml')
const gated: Array<[string, string, string]> = [
  ['isolation-canary', canary, 'metiskit-swift-test'],
  ['isolation-canary', canary, 'owner-sandbox-profile'],
  ['build', build, 'native'],
]

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' })

/** A repo whose origin/m2/integration is the first commit; the second commit adds `changedFiles`. */
function repoWithChange(changedFiles: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'native-changes-'))
  dirs.push(dir)
  git(dir, 'init', '-q', '-b', 'ticket')
  writeFileSync(join(dir, 'README.md'), 'base\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'base')
  git(dir, 'update-ref', 'refs/remotes/origin/m2/integration', 'HEAD')
  for (const f of changedFiles) {
    mkdirSync(dirname(join(dir, f)), { recursive: true })
    writeFileSync(join(dir, f), 'x\n')
  }
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'change')
  return dir
}

function decide(dir: string, event: string, ref: string): string {
  const out = join(dir, '.git', 'gh-output')
  writeFileSync(out, '')
  execFileSync('bash', [script], {
    cwd: dir,
    env: { ...process.env, GITHUB_EVENT_NAME: event, GITHUB_REF: ref, GITHUB_OUTPUT: out },
  })
  return readFileSync(out, 'utf8').trim()
}

describe('M2-0525 native surface gate', () => {
  it('skips a TypeScript-only push to a ticket branch', () => {
    const dir = repoWithChange(['src/renderer/app.tsx', 'docs/readme.md'])
    expect(decide(dir, 'push', 'refs/heads/m2/M2-0525-x')).toBe('native=false')
  })

  it.each([
    'native/mac-helper/main.swift',
    'native-app/MetisKit/Package.swift',
    'scripts/hermetic/owner-account.sb',
    'scripts/hermetic/run-swift-tests.sh',
    'AGENTS.md',
    '.github/workflows/isolation-canary.yml',
    '.github/workflows/build.yml',
    'scripts/ci/native-changes.sh',
  ])('runs a ticket-branch push that touches %s', (file) => {
    const dir = repoWithChange([file])
    expect(decide(dir, 'push', 'refs/heads/m2/M2-0525-x')).toBe('native=true')
  })

  it.each([
    ['push', 'refs/heads/m2/integration'],
    ['push', 'refs/heads/main'],
    ['push', 'refs/heads/master'],
    ['push', 'refs/heads/release/1.9.x'],
    ['workflow_dispatch', 'refs/heads/m2/M2-0525-x'],
    ['pull_request', 'refs/pull/1/merge'],
  ])('is always full for %s on %s, even with no native change', (event, ref) => {
    const dir = repoWithChange(['src/renderer/app.tsx'])
    expect(decide(dir, event, ref)).toBe('native=true')
  })

  it('fails open when there is no merge-base with origin/m2/integration', () => {
    const dir = repoWithChange(['src/renderer/app.tsx'])
    git(dir, 'update-ref', '-d', 'refs/remotes/origin/m2/integration')
    expect(decide(dir, 'push', 'refs/heads/m2/M2-0525-x')).toBe('native=true')
  })

  it.each(gated)('%s gated job %s reads the changes output and is not gated on the event', (_wf, workflow, name) => {
    const block = job(workflow, name)
    expect(block).toMatch(/\n {4}needs: changes\n/)
    expect(block).toContain("\n    if: needs.changes.outputs.native == 'true'\n")
  })

  it.each([
    ['isolation-canary', canary],
    ['build', build],
  ])('%s computes the output in an ubuntu job with a full checkout and no new third-party action', (_n, workflow) => {
    const block = job(workflow, 'changes')
    expect(block).toContain('runs-on: ubuntu-latest')
    expect(block).toContain('fetch-depth: 0')
    expect(block).toContain('run: bash scripts/ci/native-changes.sh')
    const uses = block.match(/uses: .*/g) ?? []
    expect(uses).toEqual(['uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0'])
  })

  it('lists every repository file the gated jobs reference in the one path list', () => {
    const surface = (read('scripts', 'ci', 'native-changes.sh').match(/NATIVE_SURFACE=\(\n([\s\S]*?)\n\)/)?.[1] ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    expect(surface.length).toBeGreaterThan(0)
    const text = gated
      .map(([, workflow, name]) => job(workflow, name))
      .join('\n')
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n')
    const refs = new Set(text.match(/(?:scripts|native|native-app)\/[\w./-]+|AGENTS\.md/g) ?? [])
    expect(refs.size).toBeGreaterThan(0)
    for (const ref of refs) {
      const covered = surface.some((entry) => (entry.endsWith('/') ? ref.startsWith(entry) : ref === entry))
      expect(covered, `${ref} is read by a gated job but missing from NATIVE_SURFACE`).toBe(true)
    }
    for (const wf of ['.github/workflows/isolation-canary.yml', '.github/workflows/build.yml']) {
      expect(surface).toContain(wf)
    }
  })

  it('never skips a job on a pull request into main: the script is full for that event', () => {
    const dir = repoWithChange([])
    expect(decide(dir, 'pull_request', 'refs/pull/7/merge')).toBe('native=true')
    // Every other job in both workflows keeps no dependency on the gate.
    for (const [workflow, names] of [
      [canary, ['license-server', 'deny-non-loopback', 'honeypot-check-fails-closed']],
      [build, ['quality', 'lint', 'license-server', 'operator', 'security']],
    ] as const) {
      for (const name of names) expect(job(workflow, name)).not.toContain('needs.changes')
    }
  })
})
