import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')
const workflow = readFileSync(join(root, '.github', 'workflows', 'owner-closure.yml'), 'utf8').replace(/\r\n/g, '\n')

const INPUTS = ['summary-path', 'export-path', 'checker-ref']

/** The `inputs:` block declared under one trigger, as the list of input names. */
function inputNames(trigger: 'workflow_call' | 'workflow_dispatch'): string[] {
  const start = workflow.indexOf(`\n  ${trigger}:\n`)
  expect(start).toBeGreaterThan(-1)
  const rest = workflow.slice(start + 1)
  const end = rest.slice(1).search(/\n {2}\S|\n\S/)
  const block = end === -1 ? rest : rest.slice(0, end + 1)
  return [...block.matchAll(/^ {6}([a-z-]+):$/gm)].map((m) => m[1])
}

describe('M2-0199 owner-closure workflow', () => {
  it('runs on workflow_call and workflow_dispatch only, with the same inputs on both', () => {
    expect(workflow).toMatch(/\non:\n {2}workflow_call:\n/)
    for (const trigger of ['push:', 'pull_request:', 'release:', 'schedule:']) {
      expect(workflow).not.toContain(`\n  ${trigger}\n`)
    }
    expect(inputNames('workflow_call')).toEqual(INPUTS)
    expect(inputNames('workflow_dispatch')).toEqual(INPUTS)
  })

  it('smoke-runs the fixture summary that the closure tests prove closes', () => {
    expect(workflow).toContain('default: scripts/qa/owner-soak/fixtures/closure-summary.json')
  })

  it('checks out the caller tree without credentials and fetches this repository scripts at checker-ref elsewhere', () => {
    const checkouts = workflow.split('uses: actions/checkout@').slice(1)
    expect(checkouts).toHaveLength(2)
    const [callers, scripts] = checkouts
    expect(callers).toContain('persist-credentials: false')
    expect(callers.split('\n      - ')[0]).not.toContain('repository:')
    expect(scripts).toContain('repository: mysticalsin/AskToto-Mantu')
    expect(scripts).toContain('ref: ${{ inputs.checker-ref }}')
    expect(scripts).toContain('path: .owner-closure-scripts')
  })

  it('has read-only permissions, no secrets and SHA-pinned actions', () => {
    expect(workflow).toMatch(/\npermissions:\n {2}contents: read\n\njobs:/)
    expect(workflow).not.toMatch(/secrets[.:[]/)
    const uses = [...workflow.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((m) => m[1])
    expect(uses.length).toBeGreaterThan(0)
    for (const ref of uses) expect(ref).toMatch(/@[0-9a-f]{40}$/)
  })

  it('evaluates the summary, then validates the directory with check.mjs --ticket M2-0199', () => {
    const evaluate = workflow.indexOf('node .owner-closure-scripts/scripts/qa/owner-soak/closure.mjs "${args[@]}"')
    const validate = workflow.indexOf(
      'node .owner-closure-scripts/scripts/evidence/check.mjs --ticket M2-0199 --bundle "$OUT_DIR"'
    )
    expect(evaluate).toBeGreaterThan(-1)
    expect(validate).toBeGreaterThan(evaluate)
    expect(workflow).toContain('args=(--summary "$SUMMARY_PATH" --out "$OUT_DIR")')
    expect(workflow).toContain('args+=(--export "$EXPORT_PATH")')
  })

  it('passes inputs through env, never interpolated into a shell script', () => {
    const scripts = [...workflow.matchAll(/run: \|\n((?: {10}.*\n|\n)+)/g)].map((m) => m[1])
    expect(scripts.length).toBeGreaterThan(0)
    for (const script of scripts) expect(script).not.toContain('${{')
    expect(workflow).not.toMatch(/run: [^|\n]*\$\{\{/)
  })

  it('uploads the closure directory as an artifact even when the check fails', () => {
    expect(workflow).toContain("if: always() && hashFiles('out/owner-closure/**') != ''")
    expect(workflow).toContain('path: out/owner-closure/')
  })
})
