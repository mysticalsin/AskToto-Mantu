import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')
const workflow = readFileSync(join(root, '.github', 'workflows', 'promote-candidate.yml'), 'utf8').replace(
  /\r\n/g,
  '\n'
)

const steps = workflow
  .slice(workflow.indexOf('\n    steps:\n'))
  .split(/^(?=      - )/m)
  .slice(1)
const step = (needle: string): string => {
  const found = steps.find((s) => s.includes(needle))
  expect(found, `step not found: ${needle}`).toBeDefined()
  return found!
}

describe('M2-0503 promote-candidate residuals input', () => {
  it('declares an optional residuals input that a dry run may omit', () => {
    const input = workflow.slice(workflow.indexOf('      residuals:'), workflow.indexOf('      confirm_version:'))
    expect(input).toContain('required: false')
    expect(input).toContain('type: string')
    expect(input).toContain('-F residuals=@file')
  })

  it('refuses publish=true without residuals, before any download or upload', () => {
    const guard = workflow.indexOf('[ "$PUBLISH" = true ] && [ -z "${RESIDUALS//[[:space:]]/}" ]')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(workflow.indexOf('actions/download-artifact'))
    expect(guard).toBeLessThan(workflow.indexOf('node scripts/qa/publish-dual-release.mjs'))
  })

  it('passes residuals to prepare-release through env and a file, never interpolated into a shell line', () => {
    expect(workflow.match(/RESIDUALS: \$\{\{ inputs\.residuals \}\}/g)).toHaveLength(2)
    expect(workflow.match(/inputs\.residuals/g)).toHaveLength(2)
    expect(workflow).toContain('printf \'%s\' "$RESIDUALS" > "$RUNNER_TEMP/residuals.md"')
    expect(workflow).toContain('--residuals-file "$RUNNER_TEMP/residuals.md"')
    for (const line of workflow.split('\n')) {
      if (line.includes('inputs.residuals')) expect(line).toMatch(/^\s+RESIDUALS: \$\{\{ inputs\.residuals \}\}$/)
    }
  })
})

describe('Promote candidate workflow: main and release/1.9.x candidates (M2-0500)', () => {
  it('still promotes only from a dispatch on refs/heads/main, in this repository', () => {
    expect(workflow).toMatch(
      /^    if: github\.repository == 'mysticalsin\/AskToto-Mantu' && github\.ref == 'refs\/heads\/main'$/m
    )
    expect(workflow.match(/github\.ref\b/g)).toHaveLength(1)
  })

  it('accepts a completed successful workflow_dispatch qa-candidate run whose head_branch is main or release/1.9.x, and no other', () => {
    const jq = /jq -e '(\.path == [^\n]*)' <<<"\$run"/.exec(step('Require a fully successful'))?.[1] ?? ''
    expect(jq).toContain('.path == ".github/workflows/qa-candidate.yml"')
    expect(jq).toContain('.event == "workflow_dispatch"')
    expect(jq).toContain('(.head_branch == "main" or .head_branch == "release/1.9.x")')
    expect(jq).toContain('.status == "completed" and .conclusion == "success"')
    expect(jq.match(/head_branch/g)).toHaveLength(2)
  })

  it('checks the branch and version with release-line.mjs before it downloads any artifact', () => {
    const check = step('scripts/qa/release-line.mjs candidate')
    expect(check).toContain('BRANCH: ${{ steps.candidate.outputs.branch }}')
    expect(check).toContain('--branch "$BRANCH" --package provenance/provenance.json')
    expect(steps.indexOf(check)).toBeGreaterThan(steps.indexOf(step('name: candidate-provenance')))
    expect(steps.indexOf(check)).toBeLessThan(steps.indexOf(step('name: candidate-mac')))
    expect(steps.indexOf(check)).toBeLessThan(steps.indexOf(step('prepare-release')))
  })

  it('passes the candidate branch to prepare-release and keeps confirm_version exact, never rebuilding', () => {
    expect(step('prepare-release')).toContain('--candidate-branch "$CANDIDATE_BRANCH"')
    expect(step('Confirm the candidate version')).toContain('[ "$CONFIRM" = "$VERSION" ]')
    expect(steps.indexOf(step('Confirm the candidate version'))).toBeLessThan(
      steps.indexOf(step('node scripts/qa/publish-dual-release.mjs'))
    )
    expect(workflow).not.toMatch(/npm (?:ci|run)|electron-builder /)
  })

  it('delegates publication and cleanup to the tested dual-repository state machine after staging', () => {
    const publish = step('node scripts/qa/publish-dual-release.mjs')
    expect(steps.indexOf(publish)).toBeGreaterThan(steps.indexOf(step('prepare-release')))
    expect(publish).toContain('GH_TOKEN: ${{ secrets.GH_TOKEN }}')
    expect(publish).toContain('VERSION: ${{ steps.stage.outputs.version }}')
    expect(publish).toContain('CANDIDATE_COMMIT: ${{ steps.candidate.outputs.commit }}')
    expect(publish).toContain('CANDIDATE_RUN: ${{ inputs.candidate_run_id }}')
    expect(publish).toContain('PUBLISH: ${{ inputs.publish }}')
    expect(publish).toContain('PROMOTION_DIRECTORY: ${{ runner.temp }}/promotion')
    expect(workflow.match(/node scripts\/qa\/publish-dual-release\.mjs/g)).toHaveLength(1)
    expect(workflow).not.toMatch(/gh release (?:create|view)|gh api -X (?:PATCH|DELETE)|promotion\/upload\/\*/)
  })

  it('retains only the closed receipt, even on failure, without adding a publication cleanup step', () => {
    const receipt = step('Retain the closed promotion receipt')
    expect(receipt).toContain('if: always()')
    expect(receipt).toContain('path: ${{ runner.temp }}/promotion-receipt.json')
    expect(receipt).toContain('retention-days: 7')
    expect(receipt).not.toContain('GH_TOKEN')
    expect(steps.indexOf(receipt)).toBeGreaterThan(steps.indexOf(step('node scripts/qa/publish-dual-release.mjs')))
  })
})

// The actual qa-candidate dispatch has 13 successful jobs and exactly two intentionally held
// owner-Mac rows. Run the workflow's own guard against synthetic GitHub API replies so a change
// to its shell policy, not a reimplementation in this test, determines promotion eligibility.
describe.skipIf(process.platform === 'win32')('Promote candidate job eligibility', () => {
  const expectedJobs = [
    'Check what this run may build',
    'Build mac',
    'Build win',
    'Build mac-qa-identity',
    'Record provenance',
    'ST-1 History row (macOS)',
    'ST-1 window construction per variant and chrome (shipped gated < 250 ms)',
    'History design evidence (macOS)',
    'ST-1 synthetic dataless row and stat-flags (macOS)',
    'Install and launch mac by sha256',
    'ST-1-W external unblock record',
    'Install and launch win by sha256',
    'Install and launch mac-qa-identity by sha256',
    'ST-1 control (no fixtures)',
    'ST-1 fifo stall row (macOS)'
  ]
  const heldJobs = new Set(['ST-1 control (no fixtures)', 'ST-1 fifo stall row (macOS)'])
  const completeJobs = expectedJobs.map((name) => ({
    name,
    conclusion: heldJobs.has(name) ? 'skipped' : 'success'
  }))
  type Job = (typeof completeJobs)[number]

  function runCandidateGuard(jobs: Job[], totalCount = jobs.length): number | null {
    const run = step('Require a fully successful').split('        run: |\n')[1]
    expect(run, 'candidate guard shell body').toBeDefined()
    const script = run!.replace(/^          /gm, '')
    const dir = mkdtempSync(join(tmpdir(), 'metis-candidate-eligibility-'))
    try {
      writeFileSync(
        join(dir, 'gh'),
        '#!/bin/sh\ncase "$2" in\n  */jobs*) printf %s "$METIS_TEST_JOBS_JSON" ;;\n  *) printf %s "$METIS_TEST_RUN_JSON" ;;\nesac\n',
        { mode: 0o700 }
      )
      const output = join(dir, 'output')
      writeFileSync(output, '')
      const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
        encoding: 'utf8',
        timeout: 5000,
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH ?? ''}`,
          GH_TOKEN: 'synthetic',
          GITHUB_REPOSITORY: 'mysticalsin/AskToto-Mantu',
          GITHUB_OUTPUT: output,
          RUN_ID: '12345',
          METIS_TEST_RUN_JSON: JSON.stringify({
            path: '.github/workflows/qa-candidate.yml',
            event: 'workflow_dispatch',
            head_branch: 'main',
            head_sha: 'a'.repeat(40),
            status: 'completed',
            conclusion: 'success'
          }),
          METIS_TEST_JOBS_JSON: JSON.stringify({ total_count: totalCount, jobs })
        }
      })
      expect(result.error).toBeUndefined()
      return result.status
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('accepts a successful candidate with only the two named owner-Mac rows held', () => {
    expect(runCandidateGuard(completeJobs)).toBe(0)
  })

  it('rejects a skipped required row even when the overall run says success', () => {
    const jobs = completeJobs.map((job) =>
      job.name === 'Record provenance' ? { ...job, conclusion: 'skipped' } : job
    )
    expect(runCandidateGuard(jobs)).not.toBe(0)
  })

  it('rejects a failed required row, an unknown skipped row, and a missing required row', () => {
    const failed = completeJobs.map((job) =>
      job.name === 'Build win' ? { ...job, conclusion: 'failure' } : job
    )
    expect(runCandidateGuard(failed)).not.toBe(0)
    const unknownSkip = [...completeJobs, { name: 'Unapproved skipped gate', conclusion: 'skipped' }]
    expect(runCandidateGuard(unknownSkip)).not.toBe(0)
    expect(runCandidateGuard(completeJobs.filter((job) => job.name !== 'Record provenance'))).not.toBe(0)
  })

  it('rejects a missing held row, a duplicate required row, and a truncated job response', () => {
    expect(runCandidateGuard(completeJobs.filter((job) => job.name !== 'ST-1 control (no fixtures)'))).not.toBe(0)
    const duplicate = completeJobs.map((job) =>
      job.name === 'Record provenance' ? { ...job, name: 'Build win' } : job
    )
    expect(runCandidateGuard(duplicate)).not.toBe(0)
    expect(runCandidateGuard(completeJobs, completeJobs.length + 1)).not.toBe(0)
  })
})
