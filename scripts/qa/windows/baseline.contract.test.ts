import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const SCRIPT = 'scripts/qa/windows/baseline.ps1'

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
})
