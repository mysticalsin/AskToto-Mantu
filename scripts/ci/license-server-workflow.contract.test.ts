import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8').replace(/\r\n/g, '\n')
const workflow = read('.github', 'workflows', 'build.yml')

/** The text of one top-level job, up to the next top-level job. */
function job(name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`)
  expect(start, `job not found in build.yml: ${name}`).toBeGreaterThan(-1)
  const next = workflow.slice(start + 1).search(/\n {2}[a-z][a-z0-9-]*:\n/)
  return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next)
}

describe('M2-0051 license-server CI job', () => {
  it('runs on pull requests and pushes via the workflow triggers', () => {
    expect(workflow).toMatch(/\n {2}pull_request:\n {4}branches: \[main, master\]\n/)
    expect(workflow).toMatch(/\n {2}push:\n/)
  })

  it('has no cost gate, so it runs for every pull request', () => {
    expect(job('license-server')).not.toMatch(/\n {4}if:/)
  })

  it('installs from the license-server lockfile and runs its test script in that directory', () => {
    const block = job('license-server')
    expect(block).toContain('cache-dependency-path: license-server/package-lock.json')
    expect(block).toMatch(/- run: npm ci\n {8}working-directory: license-server\n/)
    expect(block).toMatch(/- run: npm test\n {8}working-directory: license-server\n/)
  })

  it('its npm test script is node --test', () => {
    const pkg = JSON.parse(read('license-server', 'package.json')) as { scripts: Record<string, string> }
    expect(pkg.scripts.test).toMatch(/-- node --test$/)
  })
})
