import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const repo = resolve(__dirname, '..')
const scratch: string[] = []
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('MQA-326 frozen recap fixture checkout bytes', () => {
  it('preserves every pinned fixture and manifest under Windows-style autocrlf checkout', () => {
    const root = mkdtempSync(join(tmpdir(), 'metis-recap-checkout-'))
    scratch.push(root)
    const manifestPath = 'scripts/evals/fixtures/local-recap/manifest.json'
    const manifest = JSON.parse(readFileSync(join(repo, manifestPath), 'utf8')) as {
      cases: Array<{ id: string; source?: string; sha256: string }>
    }
    const fixtures = manifest.cases.map((fixture) => ({
      path: fixture.source
        ? `scripts/evals/fixtures/local-recap/${fixture.source}`
        : `src/shared/__fixtures__/golden/${fixture.id}.md`,
      expected: fixture.sha256
    }))
    const files = [manifestPath, ...fixtures.map((fixture) => fixture.path)]
    for (const path of ['.gitattributes', ...files]) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), readFileSync(join(repo, path)))
    }
    const git = (...args: string[]): Buffer => execFileSync(
      'git', ['-c', 'core.autocrlf=true', '-c', 'core.safecrlf=false', ...args],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 }
    )
    git('init', '--quiet')
    git('add', '--', '.gitattributes', ...files)
    for (const path of files) rmSync(join(root, path))
    git('checkout-index', '--force', '--all')

    expect(digest(readFileSync(join(root, manifestPath))), manifestPath)
      .toBe(digest(readFileSync(join(repo, manifestPath))))
    for (const fixture of fixtures) {
      const bytes = readFileSync(join(root, fixture.path))
      expect(digest(bytes), fixture.path).toBe(fixture.expected)
      const attrs = git('check-attr', 'eol', '--', fixture.path).toString('utf8')
      expect(attrs).toContain(': eol: lf')
    }
  })
})
