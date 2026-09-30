import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')
const read = (name: string): string => readFileSync(join(root, '.github', 'workflows', name), 'utf8').replace(/\r\n/g, '\n')
const workflow = read('program-audit.yml')

const INPUTS = [
  'mode',
  'ledger-path',
  'records-path',
  'population-of',
  'since',
  'seed',
  'gate',
  'gates-path',
  'provenance-path',
  'notes-path',
  'checker-ref'
]

/** The `inputs:` block declared under one trigger, as the list of input names. */
function inputNames(trigger: 'workflow_call' | 'workflow_dispatch'): string[] {
  const start = workflow.indexOf(`\n  ${trigger}:\n`)
  expect(start).toBeGreaterThan(-1)
  const rest = workflow.slice(start + 1)
  const end = rest.slice(1).search(/\n {2}\S|\n\S/)
  const block = end === -1 ? rest : rest.slice(0, end + 1)
  return [...block.matchAll(/^ {6}([a-z-]+):$/gm)].map((m) => m[1])
}

describe('M2-0509 program-audit workflow', () => {
  it('runs on workflow_call and workflow_dispatch only, with the same inputs on both', () => {
    expect(workflow).toMatch(/\non:\n {2}workflow_call:\n/)
    expect(workflow).toContain('\n  workflow_dispatch:\n')
    for (const trigger of ['push:', 'pull_request:', 'release:', 'schedule:']) {
      expect(workflow).not.toContain(`\n  ${trigger}\n`)
    }
    expect(inputNames('workflow_call')).toEqual(INPUTS)
    expect(inputNames('workflow_dispatch')).toEqual(INPUTS)
  })

  it('checks out the caller tree without credentials and fetches this repository scripts at checker-ref elsewhere', () => {
    const checkouts = workflow.split('uses: actions/checkout@').slice(1)
    expect(checkouts).toHaveLength(2)
    const [callers, scripts] = checkouts
    expect(callers).toContain('persist-credentials: false')
    expect(callers.split('\n      - ')[0]).not.toContain('repository:')
    expect(scripts).toContain('repository: mysticalsin/AskToto-Mantu')
    expect(scripts).toContain('ref: ${{ inputs.checker-ref }}')
    expect(scripts).toContain('path: .program-audit-scripts')
    expect(scripts).toContain('persist-credentials: false')
  })

  it('has read-only permissions, no secrets and SHA-pinned actions', () => {
    expect(workflow).toMatch(/\npermissions:\n {2}contents: read\n {2}pull-requests: read\n\njobs:/)
    expect(workflow).not.toMatch(/secrets[.:[]/)
    expect(workflow).not.toContain('secrets: inherit')
    const uses = [...workflow.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((m) => m[1])
    expect(uses.length).toBeGreaterThan(0)
    for (const ref of uses) expect(ref).toMatch(/@[0-9a-f]{40}$/)
  })

  it('validates mode, a 40-hex seed and exactly one of population-of or since before any checkout', () => {
    const validate = workflow.slice(workflow.indexOf('name: Validate the inputs'), workflow.indexOf('name: Checkout the caller'))
    expect(validate).toContain('backfill | sample | velocity | release-check')
    expect(validate).toContain("'^[0-9a-f]{40}$'")
    expect(validate).toContain('exactly one of population-of or since')
    expect(validate).toContain('release-check mode requires $name')
    expect(validate).toContain('exit 2')
  })

  it('runs the per-mode commands against the caller ledger', () => {
    expect(workflow).toContain("if: inputs.mode == 'backfill'")
    expect(workflow).toContain(
      'node .program-audit-scripts/scripts/evidence/backfill.mjs --repo mysticalsin/AskToto-Mantu --ledger "$LEDGER_PATH" --out "$OUT_DIR"'
    )
    expect(workflow).toContain('GITHUB_TOKEN: ${{ github.token }}')

    expect(workflow).toContain("if: inputs.mode == 'sample'")
    expect(workflow).toContain('args=(--ledger "$LEDGER_PATH" --seed "$SEED")')
    expect(workflow).toContain('args+=(--population-of "$POPULATION_OF")')
    expect(workflow).toContain('args+=(--since "$SINCE")')
    expect(workflow).toContain("jq --arg sha \"$GITHUB_SHA\" '. + {ledger_commit: $sha}'")

    expect(workflow).toContain("if: inputs.mode == 'velocity'")
    expect(workflow).toContain('args=(--ledger "$LEDGER_PATH" --gate "$GATE" --out-dir "$OUT_DIR")')
    expect(workflow).toContain('args+=(--records "$RECORDS_PATH")')
    expect(workflow).toContain('node .program-audit-scripts/scripts/program/velocity.mjs "${args[@]}"')

    expect(workflow).toContain("if: inputs.mode == 'release-check'")
    expect(workflow).toContain('sha256sum "$GATES_PATH" "$PROVENANCE_PATH" "$NOTES_PATH"')
  })

  it('passes inputs through env, never interpolated into a shell script', () => {
    const scripts = [...workflow.matchAll(/run: \|\n((?: {10}.*\n|\n)+)/g)].map((m) => m[1])
    expect(scripts.length).toBeGreaterThan(0)
    for (const script of scripts) expect(script).not.toContain('${{')
  })

  it('uploads a program-audit-<mode> artifact and writes each result to the job summary', () => {
    expect(workflow).toContain('name: program-audit-${{ inputs.mode }}')
    expect(workflow).toContain('path: out/program-audit/')
    expect(workflow.match(/>> "\$GITHUB_STEP_SUMMARY"/g)).toHaveLength(4)
  })

  it('names only this public repository', () => {
    const repos = workflow.match(/mysticalsin\/[\w.-]+/g) ?? []
    expect(repos.length).toBeGreaterThan(0)
    for (const repo of repos) expect(repo).toBe('mysticalsin/AskToto-Mantu')
  })
})
