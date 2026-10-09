import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
    expect(step('Require a fully successful')).toContain('all(.jobs[]; .conclusion == "success")')
    expect(step('Require a fully successful')).toContain('.total_count == (.jobs | length)')
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
