import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SCRIPT = join(__dirname, 'check-release-secrets.mjs')
// Synthetic values only; the gate checks presence, never validity.
const MAC_BASE = {
  GH_TOKEN: 'synthetic',
  CSC_LINK: 'synthetic',
  CSC_KEY_PASSWORD: 'synthetic',
  APPLE_ID: 'synthetic',
  APPLE_APP_SPECIFIC_PASSWORD: 'synthetic',
  APPLE_TEAM_ID: 'synthetic'
}
const WIN_BASE = {
  GH_TOKEN: 'synthetic',
  WIN_CSC_LINK: 'synthetic',
  WIN_CSC_KEY_PASSWORD: 'synthetic',
  WIN_CSC_EXPECTED_SUBJECT: 'synthetic'
}

function run(mode: string, env: Record<string, string>) {
  const res = spawnSync(process.execPath, [SCRIPT, mode], {
    encoding: 'utf8',
    // Only the injected env: the host's own secrets must never leak into the gate.
    env: { PATH: process.env.PATH ?? '', ...env }
  })
  return { code: res.status, out: `${res.stdout}${res.stderr}` }
}

describe('check-release-secrets Operator enrolment token gate', () => {
  for (const [mode, base] of [
    ['mac', MAC_BASE],
    ['win', WIN_BASE]
  ] as const) {
    it(`${mode}: warns, but passes, when the token is absent and not required`, () => {
      const r = run(mode, base)
      expect(r.code).toBe(0)
      expect(r.out).toMatch(/METIS_OPERATOR_ENROLL_TOKEN/)
      expect(r.out).toMatch(/SSO only/)
    })

    it(`${mode}: fails closed when METIS_OPERATOR_ENROLL_REQUIRED=1 and the token is absent`, () => {
      const r = run(mode, { ...base, METIS_OPERATOR_ENROLL_REQUIRED: '1' })
      expect(r.code).toBe(1)
      expect(r.out).toMatch(/METIS_OPERATOR_ENROLL_TOKEN/)
    })

    it(`${mode}: passes when required and the token is present`, () => {
      const r = run(mode, {
        ...base,
        METIS_OPERATOR_ENROLL_REQUIRED: '1',
        METIS_OPERATOR_ENROLL_TOKEN: 'METIS-ENR-1.testkid.testsecret'
      })
      expect(r.code).toBe(0)
    })

    it(`${mode}: rejects a malformed token when required`, () => {
      const r = run(mode, { ...base, METIS_OPERATOR_ENROLL_REQUIRED: '1', METIS_OPERATOR_ENROLL_TOKEN: 'nope' })
      expect(r.code).toBe(1)
    })
  }

  it('the token never appears in the output', () => {
    const r = run('mac', { ...MAC_BASE, METIS_OPERATOR_ENROLL_TOKEN: 'METIS-ENR-1.testkid.testsecret' })
    expect(r.out).not.toContain('testsecret')
  })

  it('mas and win-store are unaffected', () => {
    expect(run('win-store', {}).code).toBe(0)
  })
})
