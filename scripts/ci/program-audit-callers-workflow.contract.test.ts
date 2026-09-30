import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')
const workflowPath = (name: string): string => join(root, '.github', 'workflows', name)
const read = (name: string): string => readFileSync(workflowPath(name), 'utf8').replace(/\r\n/g, '\n')

const reusableLedger = read('ledger.yml')
const reusableAudit = read('program-audit.yml')
const LEDGER_PATH = '${{ vars.PROGRAM_LEDGER_PATH }}'
const RECORDS_PATH = '${{ vars.PROGRAM_RECORDS_PATH }}'
const PUBLIC_LEDGER = 'mysticalsin/AskToto-Mantu/.github/workflows/ledger.yml@main'
const PUBLIC_AUDIT = 'mysticalsin/AskToto-Mantu/.github/workflows/program-audit.yml@main'
const PRIVATE_PROGRAM_PATH_PATTERNS = [/docs\/metis-2\.0/, /evidence\/records/, /ledger\/tickets\.json/]

function jobBlock(workflow: string, jobName: string): string {
  const start = workflow.indexOf(`\n  ${jobName}:\n`)
  expect(start).toBeGreaterThan(-1)
  const rest = workflow.slice(start + 1)
  const end = rest.slice(1).search(/\n {2}\S/)
  return end === -1 ? rest : rest.slice(0, end + 1)
}

function workflowCallInputs(workflow: string): Set<string> {
  const start = workflow.indexOf('\n  workflow_call:\n')
  expect(start).toBeGreaterThan(-1)
  const rest = workflow.slice(start + 1)
  const end = rest.slice(1).search(/\n {2}\S|\n\S/)
  const block = end === -1 ? rest : rest.slice(0, end + 1)
  return new Set([...block.matchAll(/^ {6}([a-z-]+):$/gm)].map((m) => m[1]))
}

function withKeys(job: string): string[] {
  const start = job.indexOf('\n    with:\n')
  expect(start).toBeGreaterThan(-1)
  const block = job.slice(start)
  return [...block.matchAll(/^ {6}([a-z-]+):/gm)].map((m) => m[1])
}

const ledgerCaller = `
name: Program ledger check

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  ledger:
    name: Check program ledger
    uses: ${PUBLIC_LEDGER}
    with:
      ledger-path: ${LEDGER_PATH}
`

const auditCaller = `
name: Program audit dispatch

on:
  workflow_dispatch:
    inputs:
      mode:
        description: Audit mode to run
        required: true
        type: choice
        options:
          - backfill
          - sample
          - velocity
          - release-check
      population_of:
        description: Sample population ticket when since is blank
        required: false
        type: string
        default: M2-0046
      since:
        description: Sample lower bound; when set, population_of is ignored
        required: false
        type: string
      seed:
        description: Sample seed commit SHA
        required: false
        type: string
      gate:
        description: Program gate
        required: false
        type: string
        default: m3
      gates_path:
        description: Release-check gates input path
        required: false
        type: string
      provenance_path:
        description: Release-check provenance input path
        required: false
        type: string
      notes_path:
        description: Release-check notes input path
        required: false
        type: string

permissions:
  contents: read
  pull-requests: read

jobs:
  backfill:
    name: Backfill evidence records
    if: inputs.mode == 'backfill'
    uses: ${PUBLIC_AUDIT}
    with:
      mode: backfill
      ledger-path: ${LEDGER_PATH}

  sample_population:
    name: Draw sample from population ticket
    if: inputs.mode == 'sample' && inputs.since == ''
    uses: ${PUBLIC_AUDIT}
    with:
      mode: sample
      ledger-path: ${LEDGER_PATH}
      population-of: \${{ inputs.population_of }}
      seed: \${{ inputs.seed }}

  sample_since:
    name: Draw sample since bound
    if: inputs.mode == 'sample' && inputs.since != ''
    uses: ${PUBLIC_AUDIT}
    with:
      mode: sample
      ledger-path: ${LEDGER_PATH}
      since: \${{ inputs.since }}
      seed: \${{ inputs.seed }}

  velocity:
    name: Forecast velocity
    if: inputs.mode == 'velocity'
    uses: ${PUBLIC_AUDIT}
    with:
      mode: velocity
      ledger-path: ${LEDGER_PATH}
      records-path: ${RECORDS_PATH}
      gate: \${{ inputs.gate }}

  release_check:
    name: Check release evidence
    if: inputs.mode == 'release-check'
    uses: ${PUBLIC_AUDIT}
    with:
      mode: release-check
      ledger-path: ${LEDGER_PATH}
      records-path: ${RECORDS_PATH}
      gate: \${{ inputs.gate }}
      gates-path: \${{ inputs.gates_path }}
      provenance-path: \${{ inputs.provenance_path }}
      notes-path: \${{ inputs.notes_path }}
`

describe('M2-0510 program repository caller workflows', () => {
  it('does not install program-repository callers in this public repository', () => {
    expect(existsSync(workflowPath('ledger-check.yml'))).toBe(false)
    expect(existsSync(workflowPath('program-audit-dispatch.yml'))).toBe(false)
  })

  it('records the program-repository caller content that must be installed by the lead', () => {
    expect(ledgerCaller).toMatch(/\non:\n {2}push:\n {4}branches: \[main\]\n {2}workflow_dispatch:\n/)
    expect(ledgerCaller).toMatch(/\npermissions:\n {2}contents: read\n/)
    expect(ledgerCaller).toContain(`uses: ${PUBLIC_LEDGER}`)
    expect(ledgerCaller).toContain(`ledger-path: ${LEDGER_PATH}`)
    expect(ledgerCaller).not.toMatch(/\n\s*secrets:/)
  })

  it('keeps private program repository paths out of public caller files and tests', () => {
    for (const text of [ledgerCaller, auditCaller, readFileSync(__filename, 'utf8')]) {
      for (const pattern of PRIVATE_PROGRAM_PATH_PATTERNS) expect(text).not.toMatch(pattern)
    }
  })

  it('exposes exactly the program audit dispatch inputs with the required defaults', () => {
    for (const input of ['mode', 'population_of', 'since', 'seed', 'gate', 'gates_path', 'provenance_path', 'notes_path']) {
      expect(auditCaller).toMatch(new RegExp(`^ {6}${input}:$`, 'm'))
    }
    for (const mode of ['backfill', 'sample', 'velocity', 'release-check']) {
      expect(auditCaller).toMatch(new RegExp(`^ {10}- ${mode}$`, 'm'))
    }
    expect(auditCaller).toMatch(/\n {8}default: M2-0046\n/)
    expect(auditCaller).toMatch(/\n {8}default: m3\n/)
    expect(auditCaller).toMatch(/\npermissions:\n {2}contents: read\n {2}pull-requests: read\n/)
    expect(auditCaller).not.toMatch(/\n\s*secrets:/)
  })

  it('passes only the backfill inputs used by the public reusable workflow', () => {
    const block = jobBlock(auditCaller, 'backfill')
    expect(block).toContain(`uses: ${PUBLIC_AUDIT}`)
    expect(block).toContain('mode: backfill')
    expect(block).toContain(`ledger-path: ${LEDGER_PATH}`)
    expect(block).not.toContain('records-path:')
    expect(block).not.toContain('population-of:')
    expect(block).not.toContain('since:')
    expect(block).not.toContain('gate:')
  })

  it('draws samples by population by default and by since when since is supplied', () => {
    const population = jobBlock(auditCaller, 'sample_population')
    expect(population).toContain("if: inputs.mode == 'sample' && inputs.since == ''")
    expect(population).toContain(`ledger-path: ${LEDGER_PATH}`)
    expect(population).toContain('population-of: ${{ inputs.population_of }}')
    expect(population).toContain('seed: ${{ inputs.seed }}')
    expect(population).not.toContain('since:')

    const since = jobBlock(auditCaller, 'sample_since')
    expect(since).toContain("if: inputs.mode == 'sample' && inputs.since != ''")
    expect(since).toContain(`ledger-path: ${LEDGER_PATH}`)
    expect(since).toContain('since: ${{ inputs.since }}')
    expect(since).toContain('seed: ${{ inputs.seed }}')
    expect(since).not.toContain('population-of:')
  })

  it('passes the evidence records only to velocity and release-check', () => {
    const velocity = jobBlock(auditCaller, 'velocity')
    expect(velocity).toContain(`records-path: ${RECORDS_PATH}`)
    expect(velocity).toContain('gate: ${{ inputs.gate }}')
    expect(velocity).not.toContain('gates-path:')
    expect(velocity).not.toContain('provenance-path:')
    expect(velocity).not.toContain('notes-path:')

    const release = jobBlock(auditCaller, 'release_check')
    expect(release).toContain('mode: release-check')
    expect(release).toContain(`records-path: ${RECORDS_PATH}`)
    expect(release).toContain('gate: ${{ inputs.gate }}')
    expect(release).toContain('gates-path: ${{ inputs.gates_path }}')
    expect(release).toContain('provenance-path: ${{ inputs.provenance_path }}')
    expect(release).toContain('notes-path: ${{ inputs.notes_path }}')
  })

  it('passes only with keys declared by the called reusable workflows', () => {
    const ledgerInputs = workflowCallInputs(reusableLedger)
    for (const key of withKeys(jobBlock(ledgerCaller, 'ledger'))) expect(ledgerInputs.has(key)).toBe(true)

    const auditInputs = workflowCallInputs(reusableAudit)
    for (const job of ['backfill', 'sample_population', 'sample_since', 'velocity', 'release_check']) {
      for (const key of withKeys(jobBlock(auditCaller, job))) expect(auditInputs.has(key)).toBe(true)
    }
  })
})
