import { describe, expect, it } from 'vitest'
import {
  NPM_EXIT_127_ERROR,
  NPM_MISSING_NODE_ERROR,
  humanizeNpmInstallError,
  npmInstallLooksLikeMissingBinary
} from './managed-npm'

describe('MQA-287 — managed Dust npm exit 127 is a human miss, not Connected', () => {
  it('exit 127 and ENOENT map to a bundled-Node sentence (no secret leakage)', () => {
    expect(humanizeNpmInstallError(new Error('npm install --omit=dev failed in /tmp/package (exit 127)'))).toBe(
      NPM_EXIT_127_ERROR
    )
    expect(humanizeNpmInstallError(new Error('spawn /usr/bin/npm ENOENT'))).toBe(NPM_EXIT_127_ERROR)
    expect(humanizeNpmInstallError(new Error('ManagedNpmMissing: no node'))).toBe(NPM_MISSING_NODE_ERROR)
    expect(npmInstallLooksLikeMissingBinary(127)).toBe(true)
    expect(npmInstallLooksLikeMissingBinary(1)).toBe(false)
    expect(npmInstallLooksLikeMissingBinary(null, new Error('ENOENT'))).toBe(true)
    const leaked = humanizeNpmInstallError(new Error('failed with sk-ant-api03-SUPERSECRETTOKEN1234'))
    expect(leaked).not.toMatch(/SUPERSECRET/)
    expect(leaked).toMatch(/\[redacted\]/)
    expect(NPM_EXIT_127_ERROR).not.toMatch(/\u2014/)
    expect(NPM_MISSING_NODE_ERROR).not.toMatch(/Connected/)
  })
})
