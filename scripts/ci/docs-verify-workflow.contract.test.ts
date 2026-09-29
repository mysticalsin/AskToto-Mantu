import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')
const workflow = readFileSync(join(root, '.github', 'workflows', 'docs-verify.yml'), 'utf8').replace(/\r\n/g, '\n')

describe('M2-0172 docs verify workflow', () => {
  it('never runs on tags or releases and cannot write to the repository', () => {
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('pull_request:')
    expect(workflow).not.toContain('\n  push:')
    expect(workflow).not.toContain('\n  release:')
    expect(workflow).toMatch(/permissions:\n {2}contents: read\n/)
  })

  it('runs the link check and the command verifier against the checked-out commit', () => {
    expect(workflow).toContain('node scripts/docs/check-links.mjs')
    expect(workflow).toContain('node scripts/docs/verify-commands.mjs --commit "$(git rev-parse HEAD)" --out out/docs-verify')
    expect(workflow).toContain('path: out/docs-verify/')
  })

  it('runs no repository test, build or publish step', () => {
    for (const forbidden of ['npm test', 'npm run build', 'npx vitest', 'gh release', 'npm ci']) {
      expect(workflow).not.toContain(forbidden)
    }
  })
})
