import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

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

describe('QA candidate workflow: the file-fed capture smoke (M2-0495)', () => {
  const job = jobBlocks.get('capture-file-smoke-mac') ?? ''
  const jobSteps = jobBlocks.has('capture-file-smoke-mac') ? steps('capture-file-smoke-mac') : []
  const winJob = jobBlocks.get('capture-file-smoke-win') ?? ''
  const winJobSteps = jobBlocks.has('capture-file-smoke-win') ? steps('capture-file-smoke-win') : []

  it('waits for provenance and runs on macOS', () => {
    expect(job).toMatch(/^    needs: provenance$/m)
    expect(job).toMatch(/^    runs-on: macos-latest$/m)
    expect(job).toMatch(/^    timeout-minutes: 5$/m)
  })

  it('is blocking: no continue-on-error on the job or any step', () => {
    expect(job).not.toContain('continue-on-error')
  })

  it('downloads the QA-identity variant, verifies it against the provenance, then runs the smoke on it', () => {
    const download = jobSteps.findIndex((step) => step.includes('name: candidate-mac-qa-identity'))
    const verify = jobSteps.findIndex((step) => step.includes('provenance.mjs verify provenance/provenance.json assets mac-qa-identity'))
    const smoke = jobSteps.findIndex((step) => step.includes('scripts/qa/meeting/file-capture-smoke.mjs --installer'))
    expect(download).toBeGreaterThan(-1)
    expect(verify).toBeGreaterThan(download)
    expect(smoke).toBeGreaterThan(verify)
  })

  it('uploads the report even when the smoke fails', () => {
    const upload = jobSteps.find((step) => step.includes('actions/upload-artifact@')) ?? ''
    expect(upload).toContain('if: always()')
    expect(upload).toContain('name: capture-file-smoke-mac')
    expect(upload).toContain('path: capture-report/')
    expect(upload).toContain('if-no-files-found: error')
  })

  it('runs the self-test when the capture scripts or the hook change', () => {
    expect(workflow).toContain('      - scripts/qa/meeting/**\n')
    expect(workflow).toContain('      - src/main/qa-capture-source.ts\n')
  })

  it('builds the Windows QA-identity variant once, stages it and uploads its candidate artifact', () => {
    const build = jobBlocks.get('build-win') ?? ''
    expect(build).toContain('variant: win-qa-identity')
    expect(build).toContain('script: dist:win:qa-identity')
    expect(build).toContain('npm run ${{ matrix.script }}')
    expect(build).toContain('provenance.mjs stage ${{ matrix.variant }} release candidate')
    expect(build).toContain('name: candidate-${{ matrix.variant }}')
    expect(build).toContain('name: build-${{ matrix.variant }}')
  })

  it('runs a blocking Windows capture smoke on the Windows QA-identity bytes', () => {
    expect(winJob).toMatch(/^    needs: provenance$/m)
    expect(winJob).toMatch(/^    runs-on: windows-latest$/m)
    expect(winJob).toMatch(/^    timeout-minutes: 5$/m)
    expect(winJob).not.toContain('continue-on-error')
    const download = winJobSteps.findIndex((step) => step.includes('name: candidate-win-qa-identity'))
    const verify = winJobSteps.findIndex((step) => step.includes('provenance.mjs verify provenance/provenance.json assets win-qa-identity'))
    const select = winJobSteps.findIndex((step) => step.includes('candidate-installer.mjs assets $asset.sha256 win-qa-identity'))
    const smoke = winJobSteps.findIndex((step) => step.includes('file-capture-smoke.mjs --installer $installer --platform win32'))
    expect(download).toBeGreaterThan(-1)
    expect(verify).toBeGreaterThan(download)
    expect(select).toBeGreaterThan(verify)
    expect(smoke).toBeGreaterThan(select)
  })

  it('uploads the Windows capture report even when the smoke fails', () => {
    const upload = winJobSteps.find((step) => step.includes('actions/upload-artifact@')) ?? ''
    expect(upload).toContain('if: always()')
    expect(upload).toContain('name: capture-file-smoke-win')
    expect(upload).toContain('path: capture-report/')
    expect(upload).toContain('if-no-files-found: error')
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

describe('QA candidate strict ST-1 owner-runner rows (M2-0537)', () => {
  const strictJobs = ['st1-mac-fifo', 'st1-mac-control']

  it('moves only the strict fifo and control rows to the owner self-hosted Mac label', () => {
    for (const name of strictJobs) {
      expect(job(name)).toMatch(/^    runs-on: \[self-hosted, macOS, ARM64, metis-owner-mac\]$/m)
    }

    expect(job('st1-mac-dataless-synthetic')).toMatch(/^    runs-on: macos-latest$/m)
    expect(job('st1-mac-history')).toMatch(/^    runs-on: macos-latest$/m)
    expect(job('st1-mac-window')).toMatch(/^    runs-on: macos-latest$/m)
  })

  it('keeps dispatch and same-repository PRs, but refuses fork pull requests before code reaches the owner Mac', () => {
    for (const name of strictJobs) {
      expect(job(name)).toMatch(
        /^    if: github\.event_name != 'pull_request' \|\| github\.event\.pull_request\.head\.repo\.full_name == github\.repository$/m
      )
    }
  })

  it('proves the owner-account sandbox before Node setup or candidate artifact download', () => {
    for (const name of strictJobs) {
      const jobSteps = steps(name)
      const checkout = jobSteps.findIndex((step) => step.includes('actions/checkout@'))
      const probe = jobSteps.findIndex((step) => step.includes('name: Prove owner-account sandbox denies private state'))
      const setup = jobSteps.findIndex((step) => step.includes('actions/setup-node@'))
      const download = jobSteps.findIndex((step) => step.includes('actions/download-artifact@'))

      expect(checkout).toBe(0)
      expect(probe).toBe(1)
      expect(probe).toBeLessThan(setup)
      expect(probe).toBeLessThan(download)

      const block = jobSteps[probe]
      expect(block).toContain('bash scripts/hermetic/prove-owner-sandbox.sh')
    }

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
      expect(result.stdout).toContain(`${bashPath(join(home, 'Library', 'Application Support', 'Metis'))} absent -> denied`)
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
      expect(result.stdout).toContain(`::error::owner-account sandbox allowed creating absent protected path ${bashPath(allowedPath)}`)
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

  it('runs every strict candidate verification and launch through the owner-account sandbox wrapper', () => {
    for (const name of strictJobs) {
      const block = job(name)
      expect(block).toContain('bash scripts/hermetic/run-under-owner-sandbox.sh node scripts/qa/provenance.mjs verify')
      expect(block).toContain('bash scripts/hermetic/run-under-owner-sandbox.sh node scripts/qa/st-1.mjs')
      expect(block).not.toMatch(/(?:^|\n) {10}node scripts\/qa\/(?:provenance|st-1)\.mjs/)
    }
  })

  it('keeps strict rows report-only and removes temp profiles and unzipped candidates on every outcome', () => {
    for (const name of strictJobs) {
      const block = job(name)
      expect(jobContinueOnError(block)).toBe('true')
      expect(block).not.toMatch(/^    env:/m)
      for (const step of steps(name)) {
        expect(step).toContain('TMPDIR: ${{ runner.temp }}')
      }

      const cleanup = steps(name).find((step) => step.includes('name: Remove ST-1 temporary state')) ?? ''
      expect(cleanup).toMatch(/^        if: always\(\)$/m)
      expect(cleanup).toContain('rm -rf')
      expect(cleanup).toContain('"$RUNNER_TEMP"/metis-st1-*')
      expect(cleanup).toContain('"$RUNNER_TEMP"/st1-unzip-*')
      expect(cleanup).toContain('"$RUNNER_TEMP"/st1-witness-*')
      expect(cleanup).toContain('"$HOME/Library/Logs/asktoto-qa"')
      expect(cleanup).toContain('"$HOME/Library/Preferences/com.mantu.asktoto.qa.plist"')
      expect(cleanup).toContain('"$HOME/Library/Saved Application State/com.mantu.asktoto.qa.savedState"')
      expect(cleanup).toContain('"$HOME/Library/Caches/com.mantu.asktoto.qa"')
      expect(cleanup).toContain('security delete-generic-password -s "asktoto-qa Safe Storage" || true')
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
    expect(measure.indexOf('run="window-warmup-shipped-$chrome"')).toBeLessThan(measure.indexOf('for repeat in 1 2; do'))
    expect(measure).toContain('--window-warmup')
    expect(measure).toContain('--window-variant shipped')
    expect(measure).toContain('if [ "$chrome" = transparent ]; then template=(--profile-template onboarded-profile); fi')
  })

  it('keeps measured report-only window variants before measured shipped rows', () => {
    const measure = steps('st1-mac-window').find((step) => step.includes('--purpose window-construction')) ?? ''
    expect(measure).toContain('for variant in spellcheck-off paint-when-hidden prewarm-spellchecker shipped; do')
    expect(measure.indexOf('prewarm-spellchecker shipped')).toBeLessThan(measure.indexOf('--window-variant "$variant"'))
  })
})
