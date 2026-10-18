import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HISTORICAL_197 } from '../qa/historical-197-inputs.mjs'
import { BASELINE, REQUIRED_CHECKS, assessHistoricalUpgradeReport } from '../qa/historical-197-windows-upgrade.mjs'
import { assessClosedHistoricalWindowsReport, readClosedHistoricalWindowsReport } from '../qa/historical-197-windows-report.mjs'

const harness = 'a'.repeat(40)
const gatePath = join(__dirname, '../qa/historical-197-windows-report.mjs')
const workflowPath = join(__dirname, '../../.github/workflows/historical-197-windows-upgrade.yml')
const readWorkflow = () => readFileSync(workflowPath, 'utf8').replace(/\r\n/g, '\n')

function successfulReport() {
  return {
    schema: 1,
    scope: 'HEALTHY_NATIVE_196_TO_PUBLISHED_197_ONLY',
    platform: 'win32',
    harnessCommit: harness,
    appSource: HISTORICAL_197.artifactSource,
    baseline: { ...BASELINE },
    candidate: { ...HISTORICAL_197.assets[2] },
    processes: [4101, 4102, 4103],
    installers: ['1.9.6', '1.9.7'].map((version, index) => ({ version, pid: 4201 + index, exitCode: 0, censusConfirmed: true, closed: true })),
    nativeSnapshots: [0, 1, 2].map(() => ({ native: true, settingsSha256: 'b'.repeat(64), providerSha256: 'c'.repeat(64), meetingSha256: 'd'.repeat(64), fileKeyPresent: false })),
    checks: REQUIRED_CHECKS.map((id: string) => ({ id, status: 'PASS' })),
    error: null as string | null,
    accepted: true,
    limitations: ['Baseline source attribution is not signed provenance.', 'No rollback, recovery, authenticated-enterprise, ACL, foreign-account, notes, recap-generation or full-release security qualification.']
  }
}

function failedReport() {
  const report = successfulReport()
  report.processes = []
  report.installers = []
  report.nativeSnapshots = []
  report.checks = REQUIRED_CHECKS.map((id: string) => ({ id, status: id === 'inputs' ? 'FAIL' : id === 'cleanup' ? 'PASS' : 'NOT_RUN' }))
  report.error = 'inputs'
  report.accepted = false
  return report
}

describe('actual closed historical Windows report gate', () => {
  let root: string
  let reportPath: string
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'metis-historical-report-contract-'))
    reportPath = join(root, 'report.json')
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('requires the actual original assessor and a separately observed harness', async () => {
    const report = successfulReport()
    expect(assessHistoricalUpgradeReport(report)).toBe(true)
    expect(assessClosedHistoricalWindowsReport(report, harness)).toEqual({ closed: true, accepted: true })
    expect(assessClosedHistoricalWindowsReport(report, 'e'.repeat(40))).toEqual({ closed: false, accepted: false })
    await fs.writeFile(reportPath, JSON.stringify(report))
    expect(await readClosedHistoricalWindowsReport(reportPath, harness)).toEqual({ closed: true, accepted: true })
  })

  it.each(REQUIRED_CHECKS)('refuses missing, duplicate, failed and not-run accepted row %s', (id: string) => {
    for (const mutation of ['missing', 'duplicate', 'FAIL', 'NOT_RUN']) {
      const report = successfulReport()
      if (mutation === 'missing') report.checks = report.checks.filter((row) => row.id !== id)
      else if (mutation === 'duplicate') report.checks.push({ id, status: 'PASS' })
      else report.checks.find((row) => row.id === id)!.status = mutation
      expect(assessClosedHistoricalWindowsReport(report, harness)).toEqual({ closed: false, accepted: false })
    }
  })

  it('retains only a genuinely closed failed result without making it acceptance', async () => {
    const report = failedReport()
    expect(assessHistoricalUpgradeReport(report)).toBe(false)
    await fs.writeFile(reportPath, JSON.stringify(report))
    expect(await readClosedHistoricalWindowsReport(reportPath, harness)).toEqual({ closed: true, accepted: false })
    report.accepted = true
    expect(assessClosedHistoricalWindowsReport(report, harness)).toEqual({ closed: false, accepted: false })
  })

  it('refuses missing process, installer closure and native snapshot evidence', () => {
    const noProcess = successfulReport()
    noProcess.processes.pop()
    const openInstaller = successfulReport()
    openInstaller.installers[0]!.closed = false
    const noSnapshot = successfulReport()
    noSnapshot.nativeSnapshots.pop()
    for (const report of [noProcess, openInstaller, noSnapshot]) {
      expect(assessClosedHistoricalWindowsReport(report, harness)).toEqual({ closed: false, accepted: false })
    }
  })

  it('refuses private text in extra and known fields before original-report retention', async () => {
    const privateText = '/private/synthetic-report-canary'
    const variants = [
      { ...successfulReport(), extra: privateText },
      { ...successfulReport(), scope: privateText },
      { ...successfulReport(), error: privateText, accepted: false },
      { ...successfulReport(), limitations: [privateText] },
      { ...successfulReport(), nativeSnapshots: [{ ...successfulReport().nativeSnapshots[0], providerSha256: privateText }] },
      { ...successfulReport(), installers: [{ ...successfulReport().installers[0], pid: privateText }] },
      { ...failedReport(), checks: [{ id: privateText, status: 'FAIL' }] }
    ]
    for (const report of variants) {
      await fs.writeFile(reportPath, JSON.stringify(report))
      expect(await readClosedHistoricalWindowsReport(reportPath, harness)).toEqual({ closed: false, accepted: false })
    }
  })

  it('refuses symlinks, missing, malformed and oversized real files', async () => {
    expect(await readClosedHistoricalWindowsReport(reportPath, harness)).toEqual({ closed: false, accepted: false })
    await fs.writeFile(reportPath, '{')
    expect(await readClosedHistoricalWindowsReport(reportPath, harness)).toEqual({ closed: false, accepted: false })
    await fs.writeFile(reportPath, ' '.repeat(65_537))
    expect(await readClosedHistoricalWindowsReport(reportPath, harness)).toEqual({ closed: false, accepted: false })
    const target = join(root, 'target.json')
    await fs.writeFile(target, JSON.stringify(successfulReport()))
    await fs.rm(reportPath)
    await fs.symlink(target, reportPath, 'file')
    expect(await readClosedHistoricalWindowsReport(reportPath, harness)).toEqual({ closed: false, accepted: false })
  })

  it('owns one real descriptor close and refuses retention when close refuses', async () => {
    await fs.writeFile(reportPath, JSON.stringify(successfulReport()))
    const realOpen = fs.open
    let closes = 0
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...args)
      const realClose = handle.close.bind(handle)
      handle.close = async () => {
        closes += 1
        await realClose()
        throw new Error('/private/synthetic-close-refusal')
      }
      return handle
    })
    expect(await readClosedHistoricalWindowsReport(reportPath, harness)).toEqual({ closed: false, accepted: false })
    expect(closes).toBe(1)
  })

  it('executes the real CLI with distinct accepted, failed and refused exits', async () => {
    for (const [report, status, word] of [
      [successfulReport(), 0, 'PASS'],
      [failedReport(), 3, 'FAIL'],
      [{ ...successfulReport(), extra: '/private/synthetic-cli-canary' }, 2, 'REFUSED']
    ] as const) {
      await fs.writeFile(reportPath, JSON.stringify(report))
      const child = spawnSync(process.execPath, [gatePath, '--report', reportPath, '--harness-commit', harness], { encoding: 'utf8', timeout: 10_000 })
      expect(child.status).toBe(status)
      expect(child.stdout).toBe(`historical-windows-report:${word}\n`)
      expect(child.stderr).toBe('')
    }
  })
})

function requireWorkflow(source: string) {
  expect(source).toContain("run-name: ${{ github.event_name == 'pull_request' && 'Historical Windows native upgrade (registration)' || 'Historical Windows native upgrade' }}")
  expect(source).toContain("if: github.event_name == 'workflow_dispatch' && github.repository == 'mysticalsin/AskToto-Mantu' && github.ref == 'refs/heads/main'")
  expect(source).toContain('permissions:\n  contents: read\n  actions: read\n')
  expect(source).toContain('    runs-on: windows-latest\n    timeout-minutes: 40\n')
  expect(source).toContain('          persist-credentials: false\n')
  expect(source).toContain('          node-version: 22.22.3\n')
  expect(source).toContain('      - run: npm ci --ignore-scripts\n')
  expect(source).toContain('runner_temp_posix=$(cygpath -u "$RUNNER_TEMP")')
  expect(source).toContain('inputs_root=$(cygpath -m "$inputs_root_posix")')
  expect(source).toContain('test "$(git rev-parse HEAD)" = "$GITHUB_SHA" || { echo "Harness mismatch before retrieval"; exit 1; }')
  expect(source).toContain('test "$(git rev-parse HEAD)" = "$GITHUB_SHA" || { echo "Harness mismatch before execution"; exit 1; }')
  for (const asset of HISTORICAL_197.assets) expect(source).toContain(`${asset.id}\t${asset.name}\n`)
  expect(source).toContain('repos/mysticalsin/Metis-Releases/releases/395306225')
  expect(source).toContain('repos/mysticalsin/Metis-Releases/releases/assets/585098577')
  expect(source).toContain('sha256:77a532f3c33a0be6f9315e7e0df02c2420c25a297e90c5fa6baff18f84193df8')
  expect(source).toContain('harnessCommit: $harness')
  expect(source).toContain('node scripts/qa/historical-197-windows-upgrade.mjs --baseline "$INPUTS_ROOT/Metis-Setup-1.9.6.exe" --historical-metadata "$INPUTS_ROOT/context.json" --historical-assets "$INPUTS_ROOT/assets" --harness-commit "$GITHUB_SHA" --root "$APP_ROOT" --report "$INPUTS_ROOT/report.json"')
  expect(source).toContain('node scripts/qa/historical-197-windows-report.mjs --report "$INPUTS_ROOT/report.json" --harness-commit "$GITHUB_SHA"')
  expect(source).toContain('case "$gate_status" in 0|3) echo "closed=true" >> "$GITHUB_OUTPUT" ;; esac')
  expect(source).toContain('exit "$gate_status"')
  expect(source).toContain("if: always() && steps.report.outputs.closed == 'true'")
  expect(source).toContain('          path: ${{ steps.owned.outputs.inputs_root }}/report.json\n')
  expect(source).toContain('          if-no-files-found: error\n          retention-days: 1\n          overwrite: false\n')
  expect(source).toContain('"$runner_temp_windows"/metis-historical-197-inputs-*) rm -rf -- "$INPUTS_ROOT" ;;')
  expect(source.match(/GH_TOKEN: \$\{\{ github.token \}\}/g)).toHaveLength(1)
  expect(source.match(/^ {10}path:/gm)).toHaveLength(1)
  expect(source).not.toMatch(/continue-on-error|contents: write|actions: write|secrets\.|self-hosted|gh workflow run|gh release (create|edit|upload)|git push|METIS_QA_|ASKTOTO_LOCAL_KEYSTORE|rm -rf.*APP_ROOT|npm run |npx /)
  expect(source).not.toMatch(/^\s*(push|schedule|pull_request_target|workflow_call):/m)
  for (const action of ['actions/checkout@11d5960a326750d5838078e36cf38b85af677262', 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020', 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02']) expect(source).toContain(action)
}

describe('future main-only historical Windows consumer', () => {
  it('connects the actual fixed-input CLI and closed report gate without publication', () => requireWorkflow(readWorkflow()))
  it.each([
    ['registration', 'Historical Windows native upgrade (registration)', 'Historical Windows native upgrade'],
    ['foreign ref', "github.ref == 'refs/heads/main'", "github.ref != 'refs/heads/main'"],
    ['first checkout', 'test "$(git rev-parse HEAD)" = "$GITHUB_SHA" || { echo "Harness mismatch before retrieval"; exit 1; }', 'true'],
    ['last checkout', 'test "$(git rev-parse HEAD)" = "$GITHUB_SHA" || { echo "Harness mismatch before execution"; exit 1; }', 'true'],
    ['missing original asset', '645180903\tMetis-1.9.7.zip\n', ''],
    ['wrong baseline', 'assets/585098577', 'assets/585098578'],
    ['app source as harness', '--harness-commit "$GITHUB_SHA" --root', '--harness-commit "98461f85dcca49a2ded3f1489daed10d194f5229" --root'],
    ['retain ordinary crash', 'case "$gate_status" in 0|3)', 'case "$gate_status" in 0|1|3)'],
    ['mask report failure', 'exit "$gate_status"', 'exit 0'],
    ['private bytes upload', 'path: ${{ steps.owned.outputs.inputs_root }}/report.json', 'path: ${{ steps.owned.outputs.inputs_root }}/**'],
    ['delete app namespace', 'rm -rf -- "$INPUTS_ROOT"', 'rm -rf -- "$APP_ROOT"'],
    ['write permission', '  contents: read', '  contents: write']
  ])('refuses actual workflow mutation: %s', (_label, before, after) => {
    const source = readWorkflow()
    expect(source.split(before)).toHaveLength(2)
    requireWorkflow(source)
    expect(() => requireWorkflow(source.replace(before, after))).toThrow()
  })
})
