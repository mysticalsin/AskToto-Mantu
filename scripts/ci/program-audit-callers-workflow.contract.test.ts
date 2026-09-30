import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')
const read = (name: string): string => readFileSync(join(root, '.github', 'workflows', name), 'utf8').replace(/\r\n/g, '\n')

const ledger = read('ledger-check.yml')
const audit = read('program-audit-dispatch.yml')
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

describe('M2-0510 program repository caller workflows', () => {
  it('checks the program ledger on main pushes and manual dispatch using the public reusable ledger workflow', () => {
    expect(ledger).toMatch(/\non:\n {2}push:\n {4}branches: \[main\]\n {2}workflow_dispatch:\n/)
    expect(ledger).toMatch(/\npermissions:\n {2}contents: read\n/)
    expect(ledger).toContain(`uses: ${PUBLIC_LEDGER}`)
    expect(ledger).toContain(`ledger-path: ${LEDGER_PATH}`)
    expect(ledger).not.toMatch(/\n\s*secrets:/)
  })

  it('keeps private program repository paths out of public caller files and tests', () => {
    for (const text of [ledger, audit, read('program-audit-callers-workflow.contract.test.ts')]) {
      for (const pattern of PRIVATE_PROGRAM_PATH_PATTERNS) expect(text).not.toMatch(pattern)
    }
  })

  it('exposes exactly the program audit dispatch inputs with the required defaults', () => {
    for (const input of ['mode', 'population_of', 'since', 'seed', 'gate', 'gates_path', 'provenance_path', 'notes_path']) {
      expect(audit).toMatch(new RegExp(`^ {6}${input}:$`, 'm'))
    }
    for (const mode of ['backfill', 'sample', 'velocity', 'release-check']) {
      expect(audit).toMatch(new RegExp(`^ {10}- ${mode}$`, 'm'))
    }
    expect(audit).toMatch(/\n {8}default: M2-0046\n/)
    expect(audit).toMatch(/\n {8}default: m3\n/)
    expect(audit).toMatch(/\npermissions:\n {2}contents: read\n {2}pull-requests: read\n/)
    expect(audit).not.toMatch(/\n\s*secrets:/)
  })

  it('passes only the backfill inputs used by the public reusable workflow', () => {
    const block = jobBlock(audit, 'backfill')
    expect(block).toContain(`uses: ${PUBLIC_AUDIT}`)
    expect(block).toContain('mode: backfill')
    expect(block).toContain(`ledger-path: ${LEDGER_PATH}`)
    expect(block).not.toContain('records-path:')
    expect(block).not.toContain('population-of:')
    expect(block).not.toContain('since:')
    expect(block).not.toContain('gate:')
  })

  it('draws samples by population by default and by since when since is supplied', () => {
    const population = jobBlock(audit, 'sample_population')
    expect(population).toContain("if: inputs.mode == 'sample' && inputs.since == ''")
    expect(population).toContain(`ledger-path: ${LEDGER_PATH}`)
    expect(population).toContain('population-of: ${{ inputs.population_of }}')
    expect(population).toContain('seed: ${{ inputs.seed }}')
    expect(population).not.toContain('since:')

    const since = jobBlock(audit, 'sample_since')
    expect(since).toContain("if: inputs.mode == 'sample' && inputs.since != ''")
    expect(since).toContain(`ledger-path: ${LEDGER_PATH}`)
    expect(since).toContain('since: ${{ inputs.since }}')
    expect(since).toContain('seed: ${{ inputs.seed }}')
    expect(since).not.toContain('population-of:')
  })

  it('passes the evidence records only to velocity and release-check', () => {
    const velocity = jobBlock(audit, 'velocity')
    expect(velocity).toContain(`records-path: ${RECORDS_PATH}`)
    expect(velocity).toContain('gate: ${{ inputs.gate }}')
    expect(velocity).not.toContain('gates-path:')
    expect(velocity).not.toContain('provenance-path:')
    expect(velocity).not.toContain('notes-path:')

    const release = jobBlock(audit, 'release_check')
    expect(release).toContain('mode: release-check')
    expect(release).toContain(`records-path: ${RECORDS_PATH}`)
    expect(release).toContain('gate: ${{ inputs.gate }}')
    expect(release).toContain('gates-path: ${{ inputs.gates_path }}')
    expect(release).toContain('provenance-path: ${{ inputs.provenance_path }}')
    expect(release).toContain('notes-path: ${{ inputs.notes_path }}')
  })
})
