import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')
const workflow = readFileSync(join(root, '.github', 'workflows', 'kit-checks.yml'), 'utf8').replace(/\r\n/g, '\n')

function step(name: string): string {
  const start = workflow.indexOf(`      - name: ${name}`)
  expect(start, `${name} step missing`).toBeGreaterThan(-1)
  const next = workflow.indexOf('\n      - ', start + 1)
  return workflow.slice(start, next === -1 ? undefined : next)
}

describe('M2-0385 kit checks workflow', () => {
  it('self-registers without running the kit validator on pull requests', () => {
    expect(workflow).toContain("run-name: ${{ github.event_name == 'pull_request' && 'Kit checks (registration)' || 'Kit checks' }}")
    expect(workflow).toContain('  pull_request:\n    paths:\n      - .github/workflows/kit-checks.yml')
    expect(workflow).toContain("    if: github.event_name == 'workflow_dispatch'")
  })

  it('keeps the skill-registry check self-contained for program-repository copies', () => {
    const body = step('One entry, auto_install and auto_capture false')
    expect(body).toContain("node --input-type=module <<'NODE'")
    expect(body).toContain("for (const flag of ['auto_install', 'auto_capture'])")
    expect(body).toContain("entry?.[flag] !== false")
    expect(body).not.toContain('scripts/kit/check-skill-registry.mjs')
  })

  it('invokes the Hindsight package validator with its own argparse defaults', () => {
    const body = step('Hindsight package validator')
    expect(body).toContain('run: python3 "$KIT_DIR/check_hindsight_package.py"')
    expect(body).not.toContain('check_hindsight_package.py" "$KIT_DIR"')
  })
})
