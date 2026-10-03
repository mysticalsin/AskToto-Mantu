import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')
const workflow = readFileSync(join(root, '.github', 'workflows', 'promote-candidate.yml'), 'utf8').replace(/\r\n/g, '\n')

const steps = workflow.slice(workflow.indexOf('\n    steps:\n')).split(/^(?=      - )/m).slice(1)
const step = (needle: string): string => {
  const found = steps.find((s) => s.includes(needle))
  expect(found, `step not found: ${needle}`).toBeDefined()
  return found!
}

describe('Promote candidate workflow: main and release/1.9.x candidates (M2-0500)', () => {
  it('still promotes only from a dispatch on refs/heads/main, in this repository', () => {
    expect(workflow).toMatch(/^    if: github\.repository == 'mysticalsin\/AskToto-Mantu' && github\.ref == 'refs\/heads\/main'$/m)
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
    expect(step('Choose the release tag')).toContain('[ "$CONFIRM" = "$VERSION" ]')
    expect(step('Choose the release tag')).toContain('echo "tag=v$VERSION"')
    expect(workflow).not.toMatch(/npm (?:ci|run)|electron-builder /)
  })

  it('still publishes a prerelease that is never Latest, with no latest*.yml or blockmap', () => {
    expect(step('gh release create')).toContain('--draft --prerelease --latest=false')
    expect(step('Publish the prerelease')).toContain('-F prerelease=true -f make_latest=false')
    expect(step('gh release create')).toContain('"$RUNNER_TEMP"/promotion/upload/*')
  })
})
