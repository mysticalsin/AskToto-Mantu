import { describe, expect, it } from 'vitest'
import { SMOKE_SCRIPT, healthCheck, healthCommand } from './health.mjs'

const URL = 'https://staging.example.invalid'
const smokeJson = (allOk: boolean) =>
  JSON.stringify({
    baseUrl: URL,
    allOk,
    checks: [
      { name: 'GET /health (200, ok:true, version)', ok: allOk, detail: `status=200 ok=true version=abcdef1 expected=abcdef1 probe=1/5` },
      { name: '/ (302 -> Access team domain)', ok: true, detail: `status=302 location=https://team.invalid/?redirect_url=${URL}` }
    ]
  })

function fakeSpawn(stdout: string, status: number) {
  const calls: { file: string; args: string[]; options: Record<string, unknown> }[] = []
  const spawn = (file: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ file, args, options })
    return { stdout, status }
  }
  // Stands in for spawnSync, which healthCheck calls with (file, args, options) only.
  return { spawn: spawn as never, calls }
}

describe('health', () => {
  it('runs smoke.mjs read-only against the staging URL with the deployed commit as --expected-version', async () => {
    const { spawn, calls } = fakeSpawn(smokeJson(true), 0)
    const { ok, report } = await healthCheck({ url: URL, expectedVersion: 'abcdef1', spawn })
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe(process.execPath)
    expect(calls[0].args).toEqual([SMOKE_SCRIPT, '--url', URL, '--expected-version', 'abcdef1', '--json'])
    expect(SMOKE_SCRIPT).toBe('operator/scripts/smoke.mjs')
    expect(ok).toBe(true)
    expect(report).toEqual({
      expected_version: 'abcdef1',
      smoke_exit_code: 0,
      all_ok: true,
      checks: [
        { name: 'GET /health (200, ok:true, version)', ok: true },
        { name: '/ (302 -> Access team domain)', ok: true }
      ]
    })
    // Smoke details and the base URL name the staging host; none reach the report.
    expect(JSON.stringify(report)).not.toContain('staging.example.invalid')
  })

  it('fails when smoke fails, when it prints no report, and without an expected version', async () => {
    expect((await healthCheck({ url: URL, expectedVersion: 'abcdef1', spawn: fakeSpawn(smokeJson(false), 1).spawn })).ok).toBe(false)
    const silent = await healthCheck({ url: URL, expectedVersion: 'abcdef1', spawn: fakeSpawn('', 1).spawn })
    expect(silent).toEqual({
      ok: false,
      report: { expected_version: 'abcdef1', smoke_exit_code: 1, all_ok: false, checks: [], detail: 'smoke.mjs printed no JSON report' }
    })
    // A zero exit with a failing row is still a failure.
    expect((await healthCheck({ url: URL, expectedVersion: 'abcdef1', spawn: fakeSpawn(smokeJson(false), 0).spawn })).ok).toBe(false)
    expect(() => healthCommand({ url: URL, expectedVersion: '' })).toThrow(/expected-version/)
  })
})
