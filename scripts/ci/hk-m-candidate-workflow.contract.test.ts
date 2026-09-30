import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findUnpinnedUses } from './check-workflow-pins.mjs'

const root = join(__dirname, '..', '..')
const workflow = readFileSync(join(root, '.github', 'workflows', 'hk-m-candidate.yml'), 'utf8').replace(/\r\n/g, '\n')
const lines = workflow.split('\n')

function block(from: string[], header: string, indent: number): string[] {
  const start = from.findIndex((line) => line === header)
  expect(start, `block not found: ${header.trim()}`).toBeGreaterThan(-1)
  const body: string[] = []
  for (const line of from.slice(start + 1)) {
    if (line.trim() !== '' && line.length - line.trimStart().length <= indent) break
    body.push(line)
  }
  return body
}

function job(name: string): string[] {
  return block(lines, `  ${name}:`, 2)
}

function jobText(name: string): string {
  return job(name).join('\n')
}

function steps(name: string): string[] {
  const result: string[] = []
  for (const line of block(job(name), '    steps:', 4)) {
    if (/^ {6}- /.test(line)) result.push(line)
    else if (result.length) result[result.length - 1] += `\n${line}`
  }
  return result
}

function stepText(jobName: string, fragment: string): string {
  const step = steps(jobName).find((candidate) => candidate.includes(fragment))
  expect(step, `step not found: ${jobName} ${fragment}`).toBeDefined()
  return step!
}

describe('hk-m-candidate.yml contract', () => {
  it('self-registers and dispatches with the candidate run and DMG sha256 only', () => {
    expect(block(lines, 'on:', 0).filter((line) => /^ {2}\S/.test(line))).toEqual(['  pull_request:', '  workflow_dispatch:'])
    expect(block(lines, '  pull_request:', 2)).toEqual(['    paths:', '      - .github/workflows/hk-m-candidate.yml'])
    const inputs = block(lines, '    inputs:', 4)
    expect(inputs.filter((line) => /^ {6}\S/.test(line)).map((line) => line.trim())).toEqual(['candidate_run:', 'dmg_sha256:'])
    expect(workflow).toContain("'HK-M candidate (registration)'")
    expect(workflow).toContain("format('HK-M candidate {0}', inputs.candidate_run)")
  })

  it('keeps read-only contents/actions permissions, no secrets, and full-SHA-pinned actions', () => {
    expect(block(lines, 'permissions:', 0).filter((line) => line.trim())).toEqual(['  contents: read', '  actions: read'])
    expect(workflow).not.toContain('secrets.')
    expect(findUnpinnedUses(workflow)).toEqual([])
  })

  it('requires workflow_dispatch on every job for workflow registration safety', () => {
    for (const name of ['guard', 'hk-m', 'hk-m-shared']) {
      expect(jobText(name)).toContain("    if: github.event_name == 'workflow_dispatch'")
    }
  })

  it('guard refuses the wrong repository, wrong ref, and non-successful qa-candidate dispatches on main', () => {
    const guard = jobText('guard')
    expect(guard).toContain('runs-on: ubuntu-latest')
    expect(guard).toContain('"mysticalsin/AskToto-Mantu"')
    expect(guard).toContain('"refs/heads/main"')
    expect(guard).toContain('candidate_run must be a numeric run id')
    expect(guard).toContain('gh api "repos/$GITHUB_REPOSITORY/actions/runs/$CANDIDATE_RUN"')
    expect(guard).toContain('.path == ".github/workflows/qa-candidate.yml"')
    expect(guard).toContain('.event == "workflow_dispatch"')
    expect(guard).toContain('.head_branch == "main"')
    expect(guard).toContain('.status == "completed"')
    expect(guard).toContain('.conclusion == "success"')
  })

  it('runs fresh and shared HK-M jobs in parallel after the guard on the same candidate DMG', () => {
    expect(jobText('hk-m')).toContain('    needs: guard')
    expect(jobText('hk-m-shared')).toContain('    needs: guard')
    expect(stepText('hk-m', 'gh run download')).toContain('--name candidate-mac')
    expect(stepText('hk-m-shared', 'gh run download')).toContain('--name candidate-mac')
    expect(stepText('hk-m', 'provenance.mjs verify')).toContain('DMG_SHA256: ${{ inputs.dmg_sha256 }}')
    expect(stepText('hk-m-shared', 'provenance.mjs verify')).toContain('DMG_SHA256: ${{ inputs.dmg_sha256 }}')
    expect(stepText('hk-m', 'node scripts/qa/hk-m.mjs')).toContain('--cycles 20 --budget-ms 8100000')
    expect(stepText('hk-m-shared', 'node scripts/qa/hk-m.mjs')).toContain('--cycles 20 --profile shared --budget-ms 8100000')
  })

  it('uploads distinct artifacts and says failures require a fix and a new candidate', () => {
    expect(stepText('hk-m', 'actions/upload-artifact@')).toContain('name: hk-m-candidate')
    expect(stepText('hk-m-shared', 'actions/upload-artifact@')).toContain('name: hk-m-candidate-shared')
    expect(stepText('hk-m', 'did not pass every row')).toContain('requires a fix and a new candidate')
    expect(stepText('hk-m-shared', 'did not pass every row')).toContain('requires a fix and a new candidate')
  })
})
