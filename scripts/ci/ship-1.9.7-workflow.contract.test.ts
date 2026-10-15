import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFERRED_OWNER_DIAGNOSTICS } from '../qa/candidate-jobs.mjs'

const root = join(__dirname, '..', '..')
const ship = readFileSync(join(root, '.github', 'workflows', 'ship-1.9.7.yml'), 'utf8')
const promote = readFileSync(join(root, '.github', 'workflows', 'promote-1.9.7.yml'), 'utf8')
const residuals = readFileSync(join(root, '.github', 'ship-1.9.7-residuals.md'), 'utf8')

describe('unsigned 1.9.7 ship arm', () => {
  it('dispatches qa-candidate only when the arm file changes on main', () => {
    expect(ship).toContain('branches:\n      - main')
    expect(ship).toContain('- .github/ship-1.9.7')
    expect(ship).toContain('gh workflow run qa-candidate.yml')
    expect(ship).toContain('-f "commit=$GITHUB_SHA"')
    expect(ship).not.toContain('v1.9.7')
  })

  it('promotes only a successful main workflow_dispatch of the armed 1.9.7 candidate', () => {
    expect(promote).toContain('workflows: ["QA candidate"]')
    expect(promote).toContain("github.event.workflow_run.conclusion == 'success'")
    expect(promote).toContain("github.event.workflow_run.event == 'workflow_dispatch'")
    expect(promote).toContain("github.event.workflow_run.head_branch == 'main'")
    expect(promote).toContain('.github/ship-1.9.7')
    expect(promote).toContain('node scripts/qa/launch-evidence.mjs')
    expect(promote).toContain('actions/workflows/promote-candidate.yml/dispatches')
    expect(promote).toContain('publish:true')
    expect(promote).toContain('confirm_version:"1.9.7"')
    expect(promote).toContain('[ "$version" != "1.9.7" ]')
    expect(promote).not.toMatch(/npm run|electron-builder/)
  })

  it('names each held owner-Mac diagnostic on its own not-run line', () => {
    const lines = residuals.replace(/\r\n/g, '\n').split('\n')
    for (const name of DEFERRED_OWNER_DIAGNOSTICS) {
      expect(lines).toContain(`- **Not run:** \`${name}\``)
    }
  })
})
