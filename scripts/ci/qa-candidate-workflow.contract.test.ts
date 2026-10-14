import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { windowConstructionGate, windowConstructionPlan, windowRemeasurePlan } from '../qa/lib/st-1-core.mjs'

const root = join(__dirname, '..', '..')
const workflow = readFileSync(join(root, '.github', 'workflows', 'qa-candidate.yml'), 'utf8').replace(/\r\n/g, '\n')
const ownerSandboxProbePath = join(root, 'scripts', 'hermetic', 'prove-owner-sandbox.sh')
const ownerSandboxProbe = readFileSync(ownerSandboxProbePath, 'utf8').replace(/\r\n/g, '\n')

function bashPath(path: string): string {
  return path.replace(/\\/g, '/')
}

/** A job's text: from its two-space key to the next two-space key. No YAML library is a dependency here. */
function jobBlock(name: string): string {
  const lines = workflow.split('\n')
  const start = lines.findIndex((line) => line === `  ${name}:`)
  expect(start, `job not found: ${name}`).toBeGreaterThan(-1)
  const end = lines.findIndex((line, i) => i > start && /^  [A-Za-z_][A-Za-z0-9_-]*:/.test(line))
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

  it('measures the synthetic dataless row with History delayed until after five idle minutes', () => {
    expect(job).toContain('--fixtures synthetic-dataless')
    expect(job).toContain('--history after-idle')
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
    expect(job).toContain('local: { matchesStat:')
    expect(job).toContain('apfsCompressed: { matchesStat:')
    expect(job).toContain('nonAscii: { matchesStat:')
    expect(job).toContain('unstatable: { value: null')
  })

  it('uploads the synthetic-dataless report, real-dataless hosted row and stat-flags result even when a step failed', () => {
    for (const name of ['st-1-macos-synthetic-dataless', 'st-1-macos-real-dataless', 'stat-flags-macos']) {
      const upload = job.split('- uses: actions/upload-artifact@').find((part) => part.includes(`name: ${name}\n`))
      expect(upload, `upload of ${name}`).toBeDefined()
      expect(upload).toContain('if: always()')
      expect(upload).toContain('if-no-files-found: error')
    }
  })

  it('has the same continue-on-error as st1-mac-fifo, so it is blocking exactly when that job is', () => {
    const fifo = jobContinueOnError(jobBlock('st1-mac-fifo'))
    expect(fifo).toBe('false')
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
  const bodies = workflow.slice(jobsStart + '\njobs:\n'.length).split(/^(?=  [A-Za-z_][A-Za-z0-9_-]*:\n)/m)
  for (const body of bodies) {
    const name = /^  ([A-Za-z_][A-Za-z0-9_-]*):\n/.exec(body)?.[1]
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
      if (name !== 'guard')
        expect(block, `${name} names a ref`).not.toMatch(/refs\/heads\/|github\.ref\b|github\.base_ref/)
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

describe('QA candidate History design evidence (M2-0032)', () => {
  const block = jobBlocks.get('history-design-mac') ?? ''

  it('captures the promotable macOS DMG, verified against the provenance, after the candidate is recorded', () => {
    expect(block).toMatch(/^    needs: provenance$/m)
    expect(block).toMatch(/^    runs-on: macos-latest$/m)
    expect(block).toContain('name: candidate-mac\n')
    expect(block).toContain('node scripts/qa/provenance.mjs verify provenance/provenance.json assets mac\n')
    expect(block).toContain('hdiutil attach -nobrowse -readonly')
    expect(block).toContain('node scripts/qa/history-design-capture.mjs "$APP" --out history-design')
  })

  it('uploads the captures and report even when a check fails', () => {
    const [upload] = uploads(block)
    expect(upload).toContain('if: always()')
    expect(upload).toContain('name: history-design-macos')
    expect(upload).toContain('path: history-design/')
    expect(upload).toContain('if-no-files-found: error')
    expect(upload).toContain("retention-days: ${{ github.event_name == 'pull_request' && 7 || 30 }}")
  })

  // TypeScript source files are left out of the assertion: tests that read files never name them (FF-07).
  it('self-tests when the capture or the History views it captures change', () => {
    for (const path of [
      'scripts/qa/history-design-capture.mjs',
      'scripts/qa/lib/history-design.mjs',
      'src/renderer/src/components/history/**'
    ]) {
      expect(workflow).toContain(`      - ${path}\n`)
    }
  })
})

describe('QA candidate strict ST-1 hosted filesystem rows', () => {
  const strictJobs = ['st1-mac-fifo', 'st1-mac-control']

  it('runs fifo and control on disposable hosted macOS without a job skip condition', () => {
    for (const name of strictJobs) {
      expect(job(name)).toMatch(/^    runs-on: macos-latest$/m)
      expect(job(name)).not.toMatch(/^    if:/m)
    }
    for (const name of ['st1-mac-dataless-synthetic', 'st1-mac-history', 'st1-mac-window']) {
      expect(job(name)).toMatch(/^    runs-on: macos-latest$/m)
    }
  })

  it('keeps every candidate job hosted while personal-device admission remains on hold', () => {
    for (const [name, block] of jobBlocks) {
      expect(block, name).toMatch(/^ {4}runs-on: (?:ubuntu|macos|windows)-latest$/m)
      expect(block, name).not.toMatch(/self-hosted|metis-owner-mac/)
    }
    const wrapper = readFileSync(join(root, 'scripts/hermetic/run-under-owner-sandbox.sh'), 'utf8')
    expect(wrapper).toContain('if [ "${OWNER_SANDBOX_ROUTE:-}" = owner ]; then')
    expect(wrapper).toContain('owner route disabled: architectural isolation hold')
  })

  it('tests the direct owner-route refusal in an independent blocking hosted job', () => {
    const canary = readFileSync(join(root, '.github/workflows/isolation-canary.yml'), 'utf8').replace(/\r\n/g, '\n')
    const blocks = canary
      .split(/\n(?= {2}[A-Za-z_][A-Za-z0-9_-]*:)/)
      .filter((entry) => entry.startsWith('  owner-route-hold:\n'))
    expect(blocks).toHaveLength(1)
    const [block] = blocks
    expect(block).toMatch(/^ {4}runs-on: ubuntu-latest$/m)
    expect(block).toMatch(/^ {4}timeout-minutes: 5$/m)
    expect(block).not.toMatch(/^ {4}(?:if|needs|continue-on-error):/m)
    expect(block).not.toMatch(/^ {8}(?:if|continue-on-error):/m)
    expect(block).not.toMatch(/secrets\.|\bself-hosted\b/)
    expect(block).toContain('actions/checkout@11d5960a326750d5838078e36cf38b85af677262')
    expect(block).toContain('actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020')
    expect(block).toContain('persist-credentials: false')
    expect(block).toContain('node-version: 22.22.3')
    expect(block).toMatch(/^ {6}- run: node --test scripts\/hermetic\/owner-route-hold\.test\.mjs$/m)
  })

  it('uses hosted isolation without an owner-account sandbox probe or owner cleanup', () => {
    for (const name of strictJobs) {
      const block = job(name)
      expect(steps(name)[0]).toContain('actions/checkout@')
      expect(block).not.toContain('Prove owner-account sandbox denies private state')
      expect(block).not.toContain('run-under-owner-sandbox.sh')
      expect(block).not.toContain('Remove ST-1 temporary state')
      expect(block).not.toContain('$HOME')
      expect(block).not.toContain('security delete-generic-password')
    }
    // Owner denial probes remain protected even though these jobs no longer execute on that account.
    expect(workflow).toContain('      - scripts/hermetic/prove-owner-sandbox.sh\n')
    expect(workflow).toContain('      - scripts/hermetic/run-under-owner-sandbox.sh\n')
    expect(workflow).toContain('      - scripts/hermetic/owner-account.sb\n')
    expect(ownerSandboxProbe).toContain('"$HOME/Library/CloudStorage"')
    expect(ownerSandboxProbe).toContain('"$HOME/Library/Keychains"')
    expect(ownerSandboxProbe).toContain('"$HOME/Library/Application Support/Metis"')
    expect(ownerSandboxProbe).toContain('"$HOME/Library/Application Support/Métis"')
    expect(ownerSandboxProbe).toContain('"$HOME/Library/Application Support/AskToto"')
    expect(ownerSandboxProbe).toContain('"$HOME/Library/Application Support/asktoto"')
    expect(ownerSandboxProbe).toContain('"$HOME/Library/Application Support/asktoto-dev"')
    expect(ownerSandboxProbe).toContain('/bin/ls -ld "$target"')
    expect(ownerSandboxProbe).toContain('/bin/mkdir "$target"')
    expect(ownerSandboxProbe).toContain('expected at least 2')
    expect(ownerSandboxProbe).toContain("grep -Fqi 'Operation not permitted'")
    expect(ownerSandboxProbe).not.toContain('Operation not permitted|deny|sandbox')
  })

  it('proves existing paths with denied reads and absent paths with denied mkdirs', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'owner-sandbox-probe-'))
    try {
      const home = join(sandbox, 'home')
      const runnerTemp = join(sandbox, 'runner-temp')
      const log = join(sandbox, 'wrapper.log')
      const wrapper = join(sandbox, 'fake-sandbox.sh')
      mkdirSync(join(home, 'Library', 'Application Support'), { recursive: true })
      mkdirSync(join(home, 'Library', 'CloudStorage'), { recursive: true })
      mkdirSync(join(home, 'Library', 'Keychains'), { recursive: true })
      mkdirSync(runnerTemp)
      writeFileSync(
        wrapper,
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$PROBE_WRAPPER_LOG"
echo 'Operation not permitted' >&2
exit 1
`
      )
      chmodSync(wrapper, 0o755)

      const result = spawnSync('bash', [ownerSandboxProbePath], {
        cwd: root,
        env: {
          ...process.env,
          GITHUB_ACTIONS: '',
          PROVE_OWNER_SANDBOX_HOME: home,
          PROVE_OWNER_SANDBOX_WRAPPER: wrapper,
          PROBE_WRAPPER_LOG: log,
          RUNNER_TEMP: runnerTemp
        },
        encoding: 'utf8'
      })

      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
      expect(result.stdout).toContain(`${bashPath(join(home, 'Library', 'CloudStorage'))} exists -> denied`)
      expect(result.stdout).toContain(`${bashPath(join(home, 'Library', 'Keychains'))} exists -> denied`)
      expect(result.stdout).toContain(
        `${bashPath(join(home, 'Library', 'Application Support', 'Metis'))} absent -> denied`
      )
      const wrapperLog = readFileSync(log, 'utf8')
      expect(wrapperLog).toContain(`/bin/ls -ld ${bashPath(join(home, 'Library', 'CloudStorage'))}`)
      expect(wrapperLog).toContain(`/bin/ls -ld ${bashPath(join(home, 'Library', 'Keychains'))}`)
      expect(wrapperLog).toContain(`/bin/mkdir ${bashPath(join(home, 'Library', 'Application Support', 'Metis'))}`)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  it('removes an absent protected path if the sandbox unexpectedly allows mkdir', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'owner-sandbox-probe-'))
    try {
      const home = join(sandbox, 'home')
      const runnerTemp = join(sandbox, 'runner-temp')
      const wrapper = join(sandbox, 'fake-sandbox.sh')
      const allowedPath = join(home, 'Library', 'Application Support', 'Metis')
      mkdirSync(join(home, 'Library', 'Application Support'), { recursive: true })
      mkdirSync(join(home, 'Library', 'CloudStorage'), { recursive: true })
      mkdirSync(join(home, 'Library', 'Keychains'), { recursive: true })
      mkdirSync(runnerTemp)
      writeFileSync(
        wrapper,
        `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = /bin/mkdir ]; then
  shift
  exec /bin/mkdir "$@"
fi
echo 'Operation not permitted' >&2
exit 1
`
      )
      chmodSync(wrapper, 0o755)

      const result = spawnSync('bash', [ownerSandboxProbePath], {
        cwd: root,
        env: {
          ...process.env,
          GITHUB_ACTIONS: '',
          PROVE_OWNER_SANDBOX_HOME: home,
          PROVE_OWNER_SANDBOX_WRAPPER: wrapper,
          RUNNER_TEMP: runnerTemp
        },
        encoding: 'utf8'
      })

      expect(result.status).toBe(1)
      expect(result.stdout).toContain(
        `::error::owner-account sandbox allowed creating absent protected path ${bashPath(allowedPath)}`
      )
      expect(existsSync(allowedPath)).toBe(false)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  it('rejects test-only sandbox probe overrides in GitHub Actions', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'owner-sandbox-probe-'))
    try {
      const runnerTemp = join(sandbox, 'runner-temp')
      mkdirSync(runnerTemp)

      const result = spawnSync('bash', [ownerSandboxProbePath], {
        cwd: root,
        env: {
          ...process.env,
          GITHUB_ACTIONS: 'true',
          PROVE_OWNER_SANDBOX_WRAPPER: join(sandbox, 'fake-sandbox.sh'),
          RUNNER_TEMP: runnerTemp
        },
        encoding: 'utf8'
      })

      expect(result.status).toBe(1)
      expect(result.stdout).toContain(
        '::error::owner-account sandbox probe overrides are test-only and must not be set in GitHub Actions.'
      )
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  it('verifies and measures the same QA candidate directly with strict hosted exit statuses', () => {
    for (const name of strictJobs) {
      const block = job(name)
      expect(block).toContain('run: node scripts/qa/provenance.mjs verify')
      expect(block).toContain('          node scripts/qa/st-1.mjs')
      expect(jobContinueOnError(block)).toBe('false')
      expect(block).not.toMatch(/^    env:/m)
      for (const step of steps(name)) {
        expect(step).toContain('TMPDIR: ${{ runner.temp }}')
      }
      const measure = steps(name).find((step) => step.includes('scripts/qa/st-1.mjs')) ?? ''
      expect(measure).not.toContain('continue-on-error')
      expect(measure).toContain('--minutes 5')
      expect(measure).toContain('--provenance provenance/provenance.json')
      expect(measure).toContain(`--fixtures ${name === 'st1-mac-fifo' ? 'fifo' : 'none'}`)
      const [upload] = uploads(block)
      expect(upload).toContain('if: always()')
      expect(upload).toContain('if-no-files-found: error')
    }
  })

  it('re-downloads and re-verifies the candidate once after a failed byte check, and fails hard on a second bad download', () => {
    const verifyRun = 'run: node scripts/qa/provenance.mjs verify provenance/provenance.json assets mac-qa-identity\n'
    const retryIf = "        if: steps.verify1.outcome != 'success'\n"
    const pinnedDownload = /uses: (actions\/download-artifact@[0-9a-f]{40}) # v\S+/
    for (const name of strictJobs) {
      const jobSteps = steps(name)
      const isCandidateDownload = (step: string) =>
        step.includes('actions/download-artifact@') &&
        step.includes('name: candidate-mac-qa-identity\n') &&
        step.includes('path: assets\n')

      const download1 = jobSteps.findIndex((step) => isCandidateDownload(step) && step.includes('id: download1\n'))
      const verify1 = jobSteps.findIndex((step) => step.includes('name: Verify every byte against the provenance\n'))
      const wipe = jobSteps.findIndex((step) =>
        step.includes('name: Re-download the candidate after a failed byte check\n')
      )
      const download2 = jobSteps.findIndex((step, i) => i > download1 && isCandidateDownload(step))
      const verify2 = jobSteps.findIndex((step) =>
        step.includes('name: Verify every byte against the provenance (retry)\n')
      )
      const measure = jobSteps.findIndex((step) => step.includes('scripts/qa/st-1.mjs'))

      expect(download1, `${name} first download`).toBeGreaterThan(-1)
      expect([download1, verify1, wipe, download2, verify2, measure], `${name} step order`).toEqual(
        [...[download1, verify1, wipe, download2, verify2, measure]].sort((a, b) => a - b)
      )
      expect(new Set([download1, verify1, wipe, download2, verify2, measure]).size, `${name} distinct steps`).toBe(6)

      // The first attempt may fail without failing the job; the condition only reads the verify outcome.
      expect(jobSteps[download1]).toMatch(/^ {8}continue-on-error: true$/m)
      expect(jobSteps[download1]).not.toMatch(/^ {8}if:/m)
      expect(jobSteps[verify1]).toContain('id: verify1\n')
      expect(jobSteps[verify1]).toMatch(/^ {8}continue-on-error: true$/m)
      expect(jobSteps[verify1]).toContain(verifyRun)

      // The retry runs only when the first byte check failed, and starts from an empty assets directory.
      expect(jobSteps[wipe]).toContain(retryIf)
      expect(jobSteps[wipe]).toMatch(/::warning::[^\n]*attempt 1[^\n]*attempt 2/)
      expect(jobSteps[wipe]).toMatch(/^ {10}rm -rf assets$/m)
      expect(jobSteps[wipe]).not.toMatch(/rm -rf (?!assets$)/m)
      expect(jobSteps[download2]).toContain(retryIf)
      expect(jobSteps[download2]).not.toContain('continue-on-error')
      expect(pinnedDownload.exec(jobSteps[download2])?.[1]).toBe(pinnedDownload.exec(jobSteps[download1])?.[1])

      // The retry verify is the same command and nothing softens it: a second bad download fails the job.
      expect(jobSteps[verify2]).toContain(retryIf)
      expect(jobSteps[verify2]).toContain(verifyRun)
      expect(jobSteps[verify2]).not.toContain('continue-on-error')
    }

    // Other hosted jobs keep their single, hard verify.
    for (const [name, block] of jobBlocks) {
      if (strictJobs.includes(name)) continue
      expect(block, `${name} carries the diagnostic retry`).not.toContain('steps.verify1')
    }
  })

  it('preserves each diagnostic job budget for two candidate downloads plus its measurement', () => {
    // One owner-Mac candidate download took 6-10 min on 2026-10-06 (run 37522538424); with the retry the
    // control job spent 16 min downloading and the old 20-minute limit cancelled it 4 min into the measurement.
    for (const name of strictJobs) {
      expect(jobBlocks.get(name), `${name} timeout`).toMatch(/^ {4}timeout-minutes: 45$/m)
    }
  })
})

describe('QA candidate strict hosted ST-1 final reports', () => {
  const rows = [
    ['st1-mac-fifo', 'fifo', 'st-1-macos-fifo.json'],
    ['st1-mac-control', 'none', 'st-1-macos-none.json'],
    ['st1-mac-dataless-synthetic', 'synthetic-dataless', 'st-1-macos-synthetic-dataless.json']
  ]
  const installer = 'Metis-QA.zip'
  const sha = 'a'.repeat(64)
  const candidateRun = 1234

  it.each(
    rows
  )('%s rejects partial, failed, stale or unacknowledged evidence with the actual workflow predicate', (name, row, report) => {
    const block = job(name)
    expect(jobContinueOnError(block)).toBe('false')
    const measurement = steps(name).find((step) => step.includes('scripts/qa/st-1.mjs')) ?? ''
    expect(measurement).not.toContain('continue-on-error')
    const gate =
      steps(name).find((step) => step.includes('Require a complete PASS report bound to this candidate')) ?? ''
    expect(gate).toContain('if: always()')
    expect(gate).not.toContain('continue-on-error')
    expect(gate).toContain('select(.variant == "mac-qa-identity")')
    expect(gate).toContain('if length == 1 then .[0].sha256 else error("expected one QA installer") end')
    const match = gate.match(
      /jq -es --arg name "\$name" --arg sha "\$sha" --arg row "([^"]+)" --argjson run "\$GITHUB_RUN_ID" '([\s\S]+?)'\s+"st1-report\/([^"]+)"/
    )
    expect(match, 'extract the real workflow predicate').not.toBeNull()
    expect(match?.[1]).toBe(row)
    expect(match?.[3]).toBe(report)

    const safe = {
      harness: 'ST-1',
      platform: 'darwin',
      row,
      installer,
      build_run_id: candidateRun,
      artifact_sha256: sha,
      complete: true,
      verdict: 'PASS',
      teardown: { state: 'acknowledged' },
      criteria: [
        { name: 'inspector', pass: true },
        { name: 'loop', pass: true }
      ]
    }
    const rejected = [
      null,
      [],
      {},
      { ...safe, harness: 'other' },
      { ...safe, platform: 'win32' },
      { ...safe, row: 'dataless' },
      { ...safe, installer: 'different.zip' },
      { ...safe, build_run_id: candidateRun + 1 },
      { ...safe, build_run_id: String(candidateRun) },
      { ...safe, artifact_sha256: 'b'.repeat(64) },
      { ...safe, complete: false },
      { ...safe, complete: undefined },
      { ...safe, verdict: 'FAIL' },
      { ...safe, verdict: 'INCOMPLETE' },
      { ...safe, verdict: 'NOT_EXERCISED' },
      { ...safe, purpose: 'window-construction' },
      { ...safe, st1Evidence: false },
      { ...safe, teardown: undefined },
      { ...safe, teardown: { state: 'unacknowledged' } },
      { ...safe, teardown: { state: 'acknowledged', extra: true } },
      { ...safe, criteria: [] },
      { ...safe, criteria: undefined },
      { ...safe, criteria: [{ name: 'loop', pass: false }] },
      { ...safe, criteria: [{ name: 'loop' }] }
    ]
    const cases: [string, boolean][] = [
      [JSON.stringify(safe), true],
      ...rejected.map((value): [string, boolean] => [JSON.stringify(value), false]),
      ['{', false],
      ['', false],
      [' \n\t', false],
      [JSON.stringify(safe) + '\n' + JSON.stringify(safe), false],
      [JSON.stringify({ ...safe, verdict: 'FAIL' }) + '\n' + JSON.stringify(safe), false],
      [JSON.stringify(safe) + '\n' + JSON.stringify({ ...safe, verdict: 'FAIL' }), false]
    ]
    for (const [input, passes] of cases) {
      const result = spawnSync(
        'jq',
        [
          '-es',
          '--arg',
          'name',
          installer,
          '--arg',
          'sha',
          sha,
          '--arg',
          'row',
          row,
          '--argjson',
          'run',
          String(candidateRun),
          match![2]
        ],
        { input, encoding: 'utf8', timeout: 5_000 }
      )
      expect(result.error, 'jq must execute the actual workflow predicate').toBeUndefined()
      expect(result.status === 0, input).toBe(passes)
    }
  })

  it('keeps real cloud dataless proof explicitly unrun rather than treating synthetic success as cloud success', () => {
    const block = job('st1-mac-dataless-synthetic')
    expect(block).toContain('row: "dataless-real-cloud"')
    expect(block).toContain('verdict: "NOT_RUN_ON_HOSTED"')
    expect(block).toContain('Hosted runners have no cloud-file provider account')
    expect(block).not.toMatch(/dataless-real-cloud[\s\S]*verdict: "PASS"/)
    const recording =
      steps('st1-mac-dataless-synthetic').find((step) => step.includes('Record the real-cloud dataless row')) ?? ''
    expect(recording).toContain('if: always()')
  })
})

describe('QA candidate binds hosted ST-1 provenance before measurement', () => {
  const strictJobs = ['st1-mac-fifo', 'st1-mac-control', 'st1-mac-dataless-synthetic']
  const bindingName = 'Bind QA provenance to this workflow identity'
  const expected = {
    repository: 'mysticalsin/AskToto-Mantu',
    commit: 'a'.repeat(40),
    run: '12345678901',
    attempt: '2'
  }
  const producer = {
    schema: 2,
    repository: expected.repository,
    commit: expected.commit,
    run: { id: 12345678901, attempt: 2 }
  }

  it('places one hard identity check after provenance download and before installer downloads, byte checks, and ST-1', () => {
    const predicates: string[] = []
    for (const name of strictJobs) {
      const jobSteps = steps(name)
      const bindings = jobSteps.filter((step) => step.includes(`name: ${bindingName}`))
      expect(bindings, `${name} binding count`).toHaveLength(1)
      const binding = bindings[0]
      const bindingIndex = jobSteps.indexOf(binding)
      const provenanceIndex = jobSteps.findIndex((step) => step.includes('name: candidate-provenance'))
      expect(provenanceIndex).toBeGreaterThan(-1)
      expect(bindingIndex).toBeGreaterThan(provenanceIndex)
      for (const [index, step] of jobSteps.entries()) {
        if (step.includes('name: candidate-mac')) expect(bindingIndex).toBeLessThan(index)
        if (step.includes('scripts/qa/provenance.mjs verify')) expect(bindingIndex).toBeLessThan(index)
        if (step.includes('scripts/qa/st-1.mjs')) expect(bindingIndex).toBeLessThan(index)
      }
      expect(binding).toMatch(/^        env:\n          TMPDIR: \$\{\{ runner\.temp \}\}$/m)
      expect(binding).not.toMatch(/^        if:/m)
      expect(binding).not.toMatch(/^        continue-on-error:/m)
      expect(binding).not.toMatch(/secrets\.|inputs\.|github\.event\./)
      expect(binding).toContain('provenance/provenance.json > /dev/null 2>&1')
      for (const key of ['GITHUB_REPOSITORY', 'GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) {
        expect(binding).toContain(`"$${key}"`)
      }
      expect(binding).toContain('::error::QA provenance does not match this workflow identity')
      predicates.push(
        binding.match(/--arg attempt "\$GITHUB_RUN_ATTEMPT" '([\s\S]+?)'\s+provenance\/provenance\.json/)?.[1] ?? ''
      )
    }
    expect(predicates.every((predicate) => predicate.length > 0)).toBe(true)
    expect(new Set(predicates).size).toBe(1)
  })

  it('evaluates the exact workflow jq predicate against matching and mismatched producer identity', () => {
    const binding = steps('st1-mac-fifo').find((step) => step.includes(`name: ${bindingName}`)) ?? ''
    const match = binding.match(
      /--arg attempt "\$GITHUB_RUN_ATTEMPT" '([\s\S]+?)'\s+provenance\/provenance\.json/
    )
    expect(match, 'extract the actual workflow predicate').not.toBeNull()
    const predicate = match![1]

    const evaluate = (input: string, context = expected) => {
      const result = spawnSync(
        'jq',
        [
          '-es',
          '--arg',
          'repository',
          context.repository,
          '--arg',
          'commit',
          context.commit,
          '--arg',
          'run',
          context.run,
          '--arg',
          'attempt',
          context.attempt,
          predicate
        ],
        { input, encoding: 'utf8', timeout: 5_000 }
      )
      expect(result.error, 'jq must execute the actual workflow predicate').toBeUndefined()
      return result.status === 0
    }
    const document = JSON.stringify(producer)
    expect(evaluate(document)).toBe(true)

    const producerFailures = [
      { ...producer, repository: 'other/AskToto-Mantu' },
      { ...producer, repository: undefined },
      { ...producer, commit: 'b'.repeat(40) },
      { ...producer, commit: undefined },
      { ...producer, schema: 1 },
      { ...producer, schema: undefined },
      { ...producer, run: { id: 12345678902, attempt: 2 } },
      { ...producer, run: { id: 12345678901, attempt: 3 } },
      { ...producer, run: { id: '12345678901', attempt: 2 } },
      { ...producer, run: { id: 12345678901, attempt: '2' } },
      { ...producer, run: { id: 0, attempt: 2 } },
      { ...producer, run: { id: -1, attempt: 2 } },
      { ...producer, run: { id: 1.5, attempt: 2 } },
      { ...producer, run: { id: 9007199254740992, attempt: 2 } },
      { ...producer, run: { id: 12345678901, attempt: 0 } },
      { ...producer, run: { id: 12345678901, attempt: -1 } },
      { ...producer, run: { id: 12345678901, attempt: 1.5 } },
      { ...producer, run: { id: 12345678901, attempt: 9007199254740992 } },
      { ...producer, run: { id: 12345678901 } },
      { ...producer, run: { attempt: 2 } },
      { ...producer, run: undefined },
      { ...producer, run: null },
      { ...producer, run: [] }
    ]
    for (const invalid of producerFailures) expect(evaluate(JSON.stringify(invalid))).toBe(false)

    for (const invalid of [null, [], true, 2, 'text']) expect(evaluate(JSON.stringify(invalid))).toBe(false)
    const mismatch = JSON.stringify({ ...producer, repository: 'other/repo' })
    for (const input of [
      '',
      ' \n\t',
      '{',
      `${document}\n${document}`,
      `${document}\n${mismatch}`,
      `${mismatch}\n${document}`
    ]) {
      expect(evaluate(input)).toBe(false)
    }

    const invalidContexts = [
      { ...expected, repository: '' },
      { ...expected, repository: 'no-slash' },
      { ...expected, commit: '' },
      { ...expected, commit: 'a'.repeat(39) },
      ...['', '0', '-1', '1.0', '1e3', '01'].map((run) => ({ ...expected, run })),
      ...['', '0', '-1', '1.0', '1e3', '01'].map((attempt) => ({ ...expected, attempt }))
    ]
    for (const context of invalidContexts) expect(evaluate(document, context)).toBe(false)
  })
})

describe('QA candidate owned-process acknowledgement', () => {
  const windowSteps = steps('st1-mac-window')
  const measure = windowSteps.find((step) => step.includes('id: window_measure')) ?? ''
  const remeasure = windowSteps.find((step) => step.includes('id: window_remeasure')) ?? ''
  const gate = windowSteps.find((step) => step.includes('--gate-window st1-report')) ?? ''

  it('keeps both loop exit statuses and checks a final acknowledged receipt before continuing', () => {
    for (const step of [measure, remeasure]) {
      expect(step).toContain('while IFS= read -r launch; do')
      expect(step).not.toContain('| while')
      expect(step).toContain('status=0')
      expect(step).toContain('|| status=$?')
      expect(step).toContain('if ! jq -e')
      expect(step).toContain('.teardown == {"state":"acknowledged"}')
      expect(step).toContain('"st1-report/$run/$run.json" >/dev/null 2>&1; then')
      expect(step).toContain('no further launch is safe.')
      expect(step).toMatch(/no further launch is safe\.[\s\S]*exit 1\n/)
      expect(step).toContain('if [ "$status" -ne 0 ]; then echo "::warning::')
      expect(step).toMatch(/^        continue-on-error: true$/m)
    }
    expect(measure).toContain('type == "array" and length > 0')
    expect(remeasure).toContain('jq -e \'type == "array"\' st1-report/window-remeasure-plan.json')
  })

  it('evaluates both real jq receipt predicates against safe, unsafe and corrupt final reports', () => {
    const safe = { harness: 'ST-1', complete: true, verdict: 'PASS', teardown: { state: 'acknowledged' } }
    const cases: [string, boolean][] = [
      [JSON.stringify(safe), true],
      [JSON.stringify({ ...safe, verdict: 'FAIL' }), true],
      [JSON.stringify({ ...safe, complete: false, verdict: 'FAIL' }), false],
      [JSON.stringify({ ...safe, verdict: 'INCOMPLETE' }), false],
      [JSON.stringify({ ...safe, teardown: { state: 'unacknowledged', reason: 'group-still-present' } }), false],
      [JSON.stringify({ ...safe, teardown: undefined }), false],
      [JSON.stringify({ ...safe, teardown: { state: 'unknown' } }), false],
      [JSON.stringify({ ...safe, teardown: { state: 'acknowledged', extra: true } }), false],
      [JSON.stringify({ ...safe, complete: undefined }), false],
      [JSON.stringify({ ...safe, verdict: 'UNKNOWN' }), false],
      ['{', false],
      ['', false]
    ]
    for (const step of [measure, remeasure]) {
      const predicate = step.match(/if ! jq -e '([^']+)' "st1-report\/\$run\/\$run.json"/)?.[1]
      expect(predicate).toBeDefined()
      for (const [input, pass] of cases) {
        const result = spawnSync('jq', ['-e', predicate!], { input, encoding: 'utf8', timeout: 5_000 })
        expect(result.error, 'jq must execute the actual workflow predicate').toBeUndefined()
        expect(result.status === 0, input).toBe(pass)
      }
    }
  })

  it('rejects an incomplete deciding remeasure even when its window stages would satisfy the stage-only gate', () => {
    const launch = (name: string, transparent: boolean, ms: number, second: number) => ({
      name: `${name}/${name}.json`,
      report: {
        harness: 'ST-1',
        purpose: 'window-construction',
        windowVariant: 'shipped',
        complete: true,
        verdict: 'PASS',
        teardown: { state: 'acknowledged' },
        bootStages: {
          stages: ['createWindow.prewarm', 'createWindow.construct'].map((stage) => ({
            stage,
            transparent,
            ms,
            ts: new Date(second * 1_000).toISOString()
          }))
        }
      }
    })
    const slow = launch('window-shipped-opaque-1', false, 300, 1)
    const transparent = launch('window-shipped-transparent-1', true, 100, 2)
    const deciding = launch('window-remeasure-shipped-opaque', false, 100, 3)
    const incomplete = {
      ...deciding,
      report: {
        ...deciding.report,
        remeasures: 'window-shipped-opaque-1',
        complete: false,
        verdict: 'INCOMPLETE',
        harnessError: 'synthetic cleanup failure'
      }
    }
    // This is deliberately a stage-only evaluator, not a measurement-completeness gate.
    expect(windowConstructionGate([slow, transparent, incomplete]).pass).toBe(true)
    for (const step of [measure, remeasure]) {
      const predicate = step.match(/if ! jq -e '([^']+)' "st1-report\/\$run\/\$run.json"/)?.[1]
      expect(predicate).toBeDefined()
      const result = spawnSync('jq', ['-e', predicate!], {
        input: JSON.stringify(incomplete.report),
        encoding: 'utf8',
        timeout: 5_000
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
    }
  })

  it('uses outcome rather than continue-on-error conclusion and runs an empty remeasure plan safely', () => {
    expect(remeasure).toContain("if: always() && steps.window_measure.outcome == 'success'")
    expect(gate).toContain('MEASURE_OUTCOME: ${{ steps.window_measure.outcome }}')
    expect(gate).toContain('REMEASURE_OUTCOME: ${{ steps.window_remeasure.outcome }}')
    expect(gate).toMatch(/^        if: always\(\)$/m)
    expect(gate).not.toContain('.conclusion')
    const upload = windowSteps.find((step) => step.includes('name: st-1-macos-window')) ?? ''
    expect(upload).toContain('if: always()')
    expect(workflow).toContain('      - scripts/qa/lib/st-1-termination.mjs')
    expect(workflow).toContain('      - scripts/qa/lib/st-1-termination.test.ts')
  })

  it.each([
    ['success', 'success', true],
    ['failure', 'skipped', false],
    ['success', 'failure', false],
    ['', 'success', false]
  ])('gate outcomes %s/%s cannot bless an unsafe partial set', (first, second, safe) => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-st1-workflow-'))
    try {
      const command = 'node scripts/qa/st-1.mjs --gate-window st1-report --out st1-report/window-gate.json'
      const shell = gate.split('        run: |\n')[1]?.replace(/^ {10}/gm, '')
      expect(shell).toContain(command)
      // Only substitute the final stage evaluator: the actual outcome guard and receipt writer execute.
      const result = spawnSync(
        'bash',
        ['-e', '-o', 'pipefail', '-c', shell!.replace(command, "printf 'gate-called\\n'")],
        {
          cwd: dir,
          env: { ...process.env, MEASURE_OUTCOME: String(first), REMEASURE_OUTCOME: String(second) },
          encoding: 'utf8',
          timeout: 5_000
        }
      )
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(safe ? 0 : 1)
      expect(result.stdout.includes('gate-called')).toBe(safe)
      if (!safe) {
        expect(JSON.parse(readFileSync(join(dir, 'st1-report/window-gate.json'), 'utf8'))).toEqual({
          harness: 'ST-1-window-gate',
          verdict: 'INCOMPLETE',
          pass: false,
          reason: 'window-plan-incomplete'
        })
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('QA candidate workflow: the shipped window gate (M2-0519)', () => {
  const block = jobBlocks.get('st1-mac-window') ?? ''

  it('lets the window job fail: no job-level continue-on-error', () => {
    expect(block).toContain('runs-on: macos-latest')
    expect(block).not.toMatch(/^    continue-on-error:/m)
  })

  it('gates the window reports after every launch, enforcing, and uploads the gate with the reports', () => {
    const jobSteps = steps('st1-mac-window')
    const measure = jobSteps.findIndex((step) => step.includes('--purpose window-construction'))
    const gateIndex = jobSteps.findIndex((step) => step.includes('scripts/qa/st-1.mjs --gate-window st1-report'))
    expect(measure).toBeGreaterThan(-1)
    expect(gateIndex).toBeGreaterThan(measure)
    const gate = jobSteps[gateIndex]
    expect(gate).toMatch(/^        if: always\(\)$/m)
    expect(gate).not.toMatch(/continue-on-error/)
    expect(gate).toContain('--out st1-report/window-gate.json')
    expect(jobSteps.findIndex((step) => step.includes('name: st-1-macos-window'))).toBeGreaterThan(gateIndex)
  })

  it('runs one marked shipped warm-up per chrome before any measured repeats', () => {
    const measure = steps('st1-mac-window').find((step) => step.includes('--purpose window-construction')) ?? ''
    expect(measure).toContain('node scripts/qa/st-1.mjs --print-window-plan > st1-report/window-plan.json')
    expect(measure).toContain("done < <(jq -c '.[]' st1-report/window-plan.json)")
    expect(measure).toContain('run=$(jq -r \'.name\' <<<"$launch")')
    // node must not read the plan loop's stdin, or it would swallow the remaining launches.
    expect(measure).toContain('--out "st1-report/$run/$run.json" \\\n              </dev/null \\\n')
    expect(measure).toContain('--window-warmup')
    expect(measure).toContain('if [ "$warmup" = true ]; then warmup_args=(--window-warmup); fi')
    expect(measure).toContain('--window-variant "$variant"')
    expect(measure).toContain(
      'if [ "$chrome" = transparent ]; then template=(--profile-template onboarded-profile); fi'
    )
    expect(measure).not.toContain('variants=(shipped spellcheck-off paint-when-hidden prewarm-spellchecker)')
    expect(measure).not.toContain('chromes=(opaque transparent)')
  })

  it('keeps measured report-only window variants before measured shipped rows', () => {
    const measure = steps('st1-mac-window').find((step) => step.includes('--purpose window-construction')) ?? ''
    expect(measure).toContain('node scripts/qa/st-1.mjs --print-window-plan > st1-report/window-plan.json')
    expect(measure).toContain("done < <(jq -c '.[]' st1-report/window-plan.json)")
    const measured = windowConstructionPlan().filter((entry) => !entry.warmup)
    for (const repeat of [1, 2]) {
      const repeatEntries = measured.filter((entry) => entry.name.endsWith(`-${repeat}`))
      const firstShipped = repeatEntries.findIndex((entry) => entry.variant === 'shipped')
      expect(firstShipped).toBeGreaterThan(-1)
      expect(repeatEntries.slice(firstShipped).map((entry) => entry.name)).toEqual([
        `window-shipped-opaque-${repeat}`,
        `window-shipped-transparent-${repeat}`
      ])
      expect(repeatEntries.slice(0, firstShipped).every((entry) => entry.variant !== 'shipped')).toBe(true)
    }
  })

  it('takes measured repeat order from scripts/qa/st-1.mjs instead of hand-coded workflow loops', () => {
    const measure = steps('st1-mac-window').find((step) => step.includes('--purpose window-construction')) ?? ''
    expect(measure).not.toContain('for repeat in 1 2; do')
    expect(measure).not.toContain('for variant in "${variants[@]}"; do')
    expect(measure).not.toContain('for chrome in "${chromes[@]}"; do')
    expect(measure).toContain('warmup=$(jq -r \'.warmup\' <<<"$launch")')
    expect(measure).toContain('variant=$(jq -r \'.variant\' <<<"$launch")')
    expect(measure).toContain('chrome=$(jq -r \'.chrome\' <<<"$launch")')
  })

  it('re-measures a single slow shipped launch per chrome after the measured plan and before the gate (OD-66)', () => {
    const jobSteps = steps('st1-mac-window')
    const measureIndex = jobSteps.findIndex((step) => step.includes('--print-window-plan'))
    const remeasureIndex = jobSteps.findIndex((step) => step.includes('--print-window-remeasure-plan'))
    const gateIndex = jobSteps.findIndex((step) => step.includes('scripts/qa/st-1.mjs --gate-window st1-report'))
    expect(measureIndex).toBeGreaterThan(-1)
    expect(remeasureIndex).toBeGreaterThan(measureIndex)
    expect(gateIndex).toBeGreaterThan(remeasureIndex)
    const remeasure = jobSteps[remeasureIndex]
    expect(remeasure).toContain(
      'node scripts/qa/st-1.mjs --print-window-remeasure-plan st1-report > st1-report/window-remeasure-plan.json'
    )
    expect(remeasure).toContain("done < <(jq -c '.[]' st1-report/window-remeasure-plan.json)")
    expect(remeasure).toContain('remeasures=$(jq -r \'.remeasures\' <<<"$launch")')
    expect(remeasure).toContain('--purpose window-construction')
    expect(remeasure).toContain('--window-variant shipped')
    expect(remeasure).toContain('--window-remeasures "$remeasures"')
    expect(remeasure).toContain(
      'if [ "$chrome" = transparent ]; then template=(--profile-template onboarded-profile); fi'
    )
    expect(remeasure).toContain('--report-dir "st1-report/$run"')
    // The launch must not drain the plan the while-read loop is still reading.
    expect(remeasure).toContain('--out "st1-report/$run/$run.json" \\\n              </dev/null \\\n')
    expect(remeasure).not.toContain('--window-warmup')
    // A re-measure that cannot launch leaves the slow launch's failure standing; the gate step decides the job.
    expect(remeasure).toMatch(/^        continue-on-error: true$/m)
    expect(jobSteps[gateIndex]).toMatch(/^        if: always\(\)$/m)
  })

  it('adds no launch when no shipped launch reached 250 ms: the plan the workflow reads is []', () => {
    const fast = (name: string, transparent: boolean) => ({
      name: `${name}/${name}.json`,
      report: {
        purpose: 'window-construction',
        windowVariant: 'shipped',
        bootStages: {
          stages: ['createWindow.prewarm', 'createWindow.construct'].map((stage) => ({
            stage,
            ms: 249,
            ts: '2026-10-03T10:00:00.000Z',
            transparent
          }))
        }
      }
    })
    expect(
      windowRemeasurePlan([fast('window-shipped-opaque-1', false), fast('window-shipped-transparent-1', true)])
    ).toEqual([])
    expect(windowRemeasurePlan([])).toEqual([])
  })
})
