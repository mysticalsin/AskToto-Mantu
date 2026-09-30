import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const SCRIPT = 'scripts/qa/windows/baseline.ps1'
const workflow = readFileSync('.github/workflows/windows-baseline.yml', 'utf8').replace(/\r\n/g, '\n')

interface Row {
  id: string
  state?: string
  status: string
  unblock?: string
}

describe('M2-0415 Windows 1.9.6 baseline harness', () => {
  it('plan mode lists measured census rows and reports every external row BLOCKED_EXTERNAL with an unblock step', () => {
    const out = mkdtempSync(join(tmpdir(), 'm2-0415-baseline-'))
    try {
      const result = spawnSync('pwsh', ['-NoProfile', '-File', SCRIPT, '-OutDir', out, '-PlanOnly'], {
        encoding: 'utf8',
        timeout: 60_000
      })
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      expect(result.stdout).toContain('managed-edr-overhead: BLOCKED_EXTERNAL')

      const report = JSON.parse(readFileSync(join(out, 'baseline.json'), 'utf8')) as { rows: Row[]; planOnly: boolean }
      expect(report.planOnly).toBe(true)
      const byId = new Map(report.rows.map((row) => [row.id, row]))
      expect(byId.get('census-cold-start')?.status).toBe('SUPPORTED_NOT_RUN')
      expect(byId.get('census-settled-idle')?.status).toBe('SUPPORTED_NOT_RUN')
      for (const state of ['first-inference', 'active-transcription', 'post-meeting', 'post-recovery']) {
        expect(byId.get(`census-${state}`)?.status).toBe('BLOCKED_EXTERNAL')
      }
      expect(report.rows.filter((row) => row.id.startsWith('managed-')).length).toBeGreaterThanOrEqual(4)
      for (const row of report.rows.filter((r) => r.status === 'BLOCKED_EXTERNAL')) {
        expect(row.unblock?.length ?? 0).toBeGreaterThan(20)
      }
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })

  it('refuses to measure without an app path', () => {
    const out = mkdtempSync(join(tmpdir(), 'm2-0415-baseline-'))
    try {
      const result = spawnSync('pwsh', ['-NoProfile', '-File', SCRIPT, '-OutDir', out], {
        encoding: 'utf8',
        timeout: 60_000
      })
      expect(result.status).not.toBe(0)
      expect(`${result.stdout}${result.stderr}`).toContain('-App is required')
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })

  it('refuses to measure without a representative profile manifest', () => {
    const out = mkdtempSync(join(tmpdir(), 'm2-0415-baseline-'))
    const blank = mkdtempSync(join(tmpdir(), 'm2-0415-blank-profile-'))
    const env = { ...process.env }
    delete env.METIS_QA_PROFILE
    try {
      const missing = spawnSync('pwsh', ['-NoProfile', '-File', SCRIPT, '-OutDir', out, '-App', 'Metis.exe'], {
        encoding: 'utf8',
        env,
        timeout: 60_000
      })
      expect(missing.status).not.toBe(0)
      expect(`${missing.stdout}${missing.stderr}`).toContain('-QaProfile or METIS_QA_PROFILE is required')

      const empty = spawnSync(
        'pwsh',
        ['-NoProfile', '-File', SCRIPT, '-OutDir', out, '-App', 'Metis.exe', '-QaProfile', blank],
        { encoding: 'utf8', env, timeout: 60_000 }
      )
      expect(empty.status).not.toBe(0)
      expect(`${empty.stdout}${empty.stderr}`).toContain('resource-census-profile.json is missing')
    } finally {
      rmSync(out, { recursive: true, force: true })
      rmSync(blank, { recursive: true, force: true })
    }
  })
})

function workflowEvents(): string[] {
  const lines = workflow.split('\n')
  const on = lines.findIndex((line) => line === 'on:')
  expect(on, 'workflow on: block missing').toBeGreaterThan(-1)
  const events: string[] = []
  for (const line of lines.slice(on + 1)) {
    if (/^[A-Za-z_][A-Za-z0-9_-]*:/.test(line)) break
    const event = /^ {2}([A-Za-z_][A-Za-z0-9_-]*):/.exec(line)?.[1]
    if (event) events.push(event)
  }
  return events
}

function jobBlock(name: string): string {
  const lines = workflow.split('\n')
  const start = lines.findIndex((line) => line === `  ${name}:`)
  expect(start, `job not found: ${name}`).toBeGreaterThan(-1)
  const end = lines.findIndex((line, index) => index > start && /^ {2}[A-Za-z_][A-Za-z0-9_-]*:/.test(line))
  return lines.slice(start, end === -1 ? undefined : end).join('\n')
}

describe('M2-0415 Windows baseline workflow lane', () => {
  it('is manual-only and guarded to main on a hosted Windows runner', () => {
    expect(workflowEvents()).toEqual(['workflow_dispatch'])
    const baseline = jobBlock('baseline')
    expect(baseline).toContain("runs-on: windows-latest")
    expect(baseline).toContain("if: github.ref == 'refs/heads/main'")
    expect(baseline).not.toContain('pull_request')
  })

  it('installs the published 1.9.6 artifact before measuring with the baseline harness', () => {
    const baseline = jobBlock('baseline')
    expect(workflow).toContain("default: v1.9.6-unsigned")
    expect(baseline).toContain("gh release download $env:RELEASE_TAG")
    expect(baseline).toContain("node scripts/qa/verify-sha256sums.mjs release-artifact $sums")
    expect(baseline).toContain("Start-Process -FilePath $setup.FullName")
    expect(baseline).toContain("./scripts/qa/windows/baseline.ps1")
    expect(baseline).toContain("-App \"$env:RUNNER_TEMP\\windows-baseline-install\\Metis.exe\"")
  })

  it('uploads the content-free baseline rows for the lead to file as private evidence', () => {
    const baseline = jobBlock('baseline')
    expect(baseline).toContain('path: baseline-output/')
    expect(baseline).toContain('if-no-files-found: error')
    expect(baseline).toContain('Get-Content baseline-output/baseline.json')
  })
})
