import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')
const workflow = readFileSync(join(root, '.github', 'workflows', 'qa-candidate.yml'), 'utf8').replace(/\r\n/g, '\n')

/** A job's text: from its two-space key to the next two-space key. No YAML library is a dependency here. */
function jobBlock(name: string): string {
  const lines = workflow.split('\n')
  const start = lines.findIndex((line) => line === `  ${name}:`)
  expect(start, `job not found: ${name}`).toBeGreaterThan(-1)
  const end = lines.findIndex((line, i) => i > start && /^  [A-Za-z0-9_-]+:/.test(line))
  return lines.slice(start, end === -1 ? undefined : end).join('\n')
}

/** The job's own `continue-on-error`, at job level (four-space indent). */
function jobContinueOnError(block: string): string | undefined {
  return block.match(/^ {4}continue-on-error: (.+)$/m)?.[1]
}

describe('QA candidate job st1-mac-dataless-synthetic (M2-0505, OD-36)', () => {
  const job = jobBlock('st1-mac-dataless-synthetic')

  it('runs on macOS after provenance', () => {
    expect(job).toContain('needs: provenance')
    expect(job).toContain('runs-on: macos-latest')
  })

  it('verifies the QA-identity variant and the promotable DMG against the provenance', () => {
    expect(job).toContain('name: candidate-mac-qa-identity')
    expect(job).toContain('provenance.mjs verify provenance/provenance.json assets mac-qa-identity')
    expect(job).toContain('name: candidate-mac\n')
    expect(job).toContain('provenance.mjs verify provenance/provenance.json assets-mac mac')
  })

  it('measures the synthetic dataless row with History off for five minutes', () => {
    expect(job).toContain('--fixtures synthetic-dataless')
    expect(job).toContain('--history off')
    expect(job).toContain('--minutes 5')
    expect(job).toContain('--out st1-report/st-1-macos-synthetic-dataless.json')
  })

  it('records the real-cloud dataless row as not run, with the SF_DATALESS probe under sudo', () => {
    expect(job).toContain('st-1-macos-real-dataless.json')
    expect(job).toContain('row: "dataless-real-cloud"')
    expect(job).toContain('verdict: "NOT_RUN_ON_HOSTED"')
    expect(job).toContain('measuredBy: "post-release field soak diagnostics"')
    expect(job).toContain('sudo python3')
    expect(job).toContain('sfDatalessProbe: { settable: $settable, errno: $errno')
    expect(job).toContain('sudo rm -f "$scratch"')
    expect(job).not.toMatch(/dataless-real-cloud[\s\S]*verdict: "PASS"/)
  })

  it('runs the DMG helper through stat-flags-fixture.sh --local-only and keeps its result', () => {
    expect(job).toContain('hdiutil attach')
    expect(job).toContain('Contents/Resources/mac-helper/metis-mac-helper')
    expect(job).toContain('scripts/qa/stat-flags-fixture.sh "$helper" --local-only')
    expect(job).toContain('stat-flags-report/stat-flags-macos.json')
    expect(job).toContain('datalessFileCheck: "NOT_RUN_ON_HOSTED"')
  })

  it('uploads the synthetic-dataless report and the stat-flags result even when a step failed', () => {
    for (const name of ['st-1-macos-synthetic-dataless', 'stat-flags-macos']) {
      const upload = job.split('- uses: actions/upload-artifact@').find((part) => part.includes(`name: ${name}\n`))
      expect(upload, `upload of ${name}`).toBeDefined()
      expect(upload).toContain('if: always()')
      expect(upload).toContain('if-no-files-found: error')
    }
  })

  it('has the same continue-on-error as st1-mac-fifo, so it is blocking exactly when that job is', () => {
    const fifo = jobContinueOnError(jobBlock('st1-mac-fifo'))
    expect(fifo).toBeDefined()
    expect(jobContinueOnError(job)).toBe(fifo)
  })

  it('is part of the self-test trigger for its own files', () => {
    expect(workflow).toContain('      - scripts/qa/stat-flags-fixture.sh')
  })
})

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
