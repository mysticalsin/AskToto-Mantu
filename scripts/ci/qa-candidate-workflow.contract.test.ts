import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')
const workflow = readFileSync(join(root, '.github', 'workflows', 'qa-candidate.yml'), 'utf8').replace(/\r\n/g, '\n')

/** The text of one top-level job, from its `  <name>:` line to the next job. */
function job(name: string): string {
  const lines = workflow.split('\n')
  const start = lines.findIndex((line) => line === `  ${name}:`)
  expect(start, `job not found: ${name}`).toBeGreaterThan(-1)
  const end = lines.findIndex((line, index) => index > start && /^ {2}[A-Za-z_][A-Za-z0-9_-]*:/.test(line))
  return lines.slice(start, end === -1 ? undefined : end).join('\n')
}

/** The `uses: actions/upload-artifact` step blocks of a job. */
function uploads(block: string): string[] {
  return block.split(/\n(?= {6}- )/).filter((step) => step.includes('actions/upload-artifact@'))
}

describe('qa-candidate smoke jobs write per-asset launch reports (M2-0508)', () => {
  it.each([
    ['smoke-mac', 'candidate-launch-${{ matrix.variant }}'],
    ['smoke-win', 'candidate-launch-win']
  ])('%s uploads its reports even on failure, fails without them and keeps the shared retention', (name, artifact) => {
    const [upload] = uploads(job(name))
    expect(upload).toContain('if: always()')
    expect(upload).toContain(`name: ${artifact}`)
    expect(upload).toContain('path: launch-reports/')
    expect(upload).toContain('if-no-files-found: error')
    expect(upload).toContain("retention-days: ${{ github.event_name == 'pull_request' && 7 || 30 }}")
  })

  it('smoke-mac passes every report flag to the launch gate and checks each report against provenance', () => {
    const block = job('smoke-mac')
    for (const flag of ['--report', '--installer', '--artifact-sha256', '--candidate-run', '--signature']) {
      expect(block, flag).toContain(`${flag} `)
    }
    expect(block).toContain('ASKTOTO_MAC_LAUNCH_GATE=1 node scripts/check-packaged-launch.mjs "$app"')
    expect(block).toContain('.verdict == "PASS" and .artifact_sha256 == $h')
    expect(block).toContain('"launch-reports/$name.launch.json"')
  })

  it('smoke-win reports the Setup and the Portable with their Authenticode status and checks provenance', () => {
    const block = job('smoke-win')
    for (const flag of ['--report', '--installer', '--artifact-sha256', '--candidate-run', '--signature']) {
      expect(block, flag).toContain(`${flag} `)
    }
    expect(block).toContain('Get-AuthenticodeSignature')
    expect(block).toContain('Installer = $setup')
    expect(block).toContain('Installer = $portable')
    expect(block).toContain("$report.verdict -ne 'PASS'")
    expect(block).toContain('$report.artifact_sha256 -ne $asset.sha256')
  })
})

const jobsStart = workflow.indexOf('\njobs:\n')
const jobBlocks = new Map<string, string>()
{
  const bodies = workflow.slice(jobsStart + '\njobs:\n'.length).split(/^(?=  [a-z0-9-]+:\n)/m)
  for (const body of bodies) {
    const name = /^  ([a-z0-9-]+):\n/.exec(body)?.[1]
    if (name) jobBlocks.set(name, body)
  }
}

function steps(jobName: string): string[] {
  const block = jobBlocks.get(jobName)
  expect(block, `job not found: ${jobName}`).toBeDefined()
  return block!.split(/^(?=      - )/m).slice(1)
}

describe('QA candidate workflow: which refs and versions may build (M2-0499)', () => {
  const guard = jobBlocks.get('guard') ?? ''
  const guardSteps = steps('guard')
  const dispatchRefStep = guardSteps.find((step) => step.includes('may not build a candidate')) ?? ''

  it('allows workflow_dispatch on refs/heads/main and refs/heads/release/1.9.x only, and names both when refusing', () => {
    expect(dispatchRefStep).toContain("if: github.event_name == 'workflow_dispatch'")
    expect(dispatchRefStep).toContain('refs/heads/main|refs/heads/release/1.9.x) ;;')
    expect(dispatchRefStep).toMatch(/\*\)\n[^\n]*::error::[^\n]*refs\/heads\/main[^\n]*refs\/heads\/release\/1\.9\.x/)
    const allowed = dispatchRefStep.match(/refs\/heads\/[A-Za-z0-9/_-]+(?:\.[A-Za-z0-9]+)*/g) ?? []
    expect([...new Set(allowed)].sort()).toEqual(['refs/heads/main', 'refs/heads/release/1.9.x'])
  })

  it('still requires the named commit to be the dispatched ref head, and says which ref', () => {
    const step = guardSteps.find((s) => s.includes('COMMIT: ${{ inputs.commit }}')) ?? ''
    expect(step).toContain('[ "$COMMIT" != "$GITHUB_SHA" ]')
    expect(step).toContain('$GITHUB_REF')
  })

  it('carries no ref condition on any job, and only the guard job names a ref', () => {
    for (const [name, block] of jobBlocks) {
      const jobIf = /^    if: (.*)$/m.exec(block)?.[1] ?? ''
      expect(jobIf, `${name} job condition`).not.toMatch(/github\.ref/)
      if (name !== 'guard') expect(block, `${name} names a ref`).not.toMatch(/refs\/heads\/|github\.ref\b|github\.base_ref/)
    }
    expect(guard).toContain('refs/heads/')
  })

  it('checks the version in the guard, and every build job waits for the guard', () => {
    const versionIndex = guardSteps.findIndex((step) => step.includes('scripts/qa/release-line.mjs check'))
    expect(versionIndex).toBeGreaterThan(-1)
    const checkoutIndex = guardSteps.findIndex((step) => step.includes('actions/checkout@'))
    expect(checkoutIndex).toBeGreaterThan(-1)
    expect(checkoutIndex).toBeLessThan(versionIndex)
    for (const build of ['build-mac', 'build-win']) {
      expect(jobBlocks.get(build)).toMatch(/^    needs: guard$/m)
    }
    // Every other job is downstream of a build job.
    expect(jobBlocks.get('provenance')).toMatch(/^    needs: \[build-mac, build-win\]$/m)
  })

  it('reads the feed with the workflow token only, and fails closed naming the call on a dispatch', () => {
    const step = guardSteps[guardSteps.findIndex((s) => s.includes('scripts/qa/release-line.mjs check'))]
    expect(step).toContain('GH_TOKEN: ${{ github.token }}')
    expect(step).not.toMatch(/secrets\./)
    expect(step).toContain('gh api "repos/$FEED/git/matching-refs/tags"')
    expect(step).toContain('gh api "repos/$FEED/releases')
    expect(step).toContain('feed_failed "gh api repos/$FEED/git/matching-refs/tags"')
    expect(step).toContain('feed_failed "gh api repos/$FEED/releases"')
    expect(step).toMatch(/::error::\$1 failed/)
  })

  it('is report-only on pull_request and enforcing on dispatch', () => {
    const step = guardSteps.find((s) => s.includes('scripts/qa/release-line.mjs check')) ?? ''
    expect(step).toContain("REPORT_ONLY: ${{ github.event_name == 'pull_request' }}")
    expect(step).toContain('--report-only')
    expect(step).toMatch(/::warning::\$1 failed/)
    expect(step).not.toMatch(/^\s+if: /m)
  })

  it('requires release/1.9.x to contain the promoted v1.9.7 commit', () => {
    const step = guardSteps.find((s) => s.includes('git merge-base --is-ancestor')) ?? ''
    expect(step).toContain("github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/release/1.9.x'")
    expect(step).toContain('gh release download v1.9.7')
    expect(step).toContain('"$base" "$GITHUB_SHA"')
    expect(guard).toMatch(/fetch-depth: 0/)
  })

  it('runs the self-test when the rule itself changes', () => {
    expect(workflow).toContain('      - scripts/qa/release-line.mjs\n')
  })
})
