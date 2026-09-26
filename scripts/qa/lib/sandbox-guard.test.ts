import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertSandboxedUserData } from './sandbox-guard.mjs'

// W0-HERMETIC (M2-0190) — e2e-workflows.mjs calls assertSandboxedUserData() before it touches a
// CDP-connected app's settings/brain on disk. This is an allow-list (under the OS temp dir, or outside
// the home directory entirely), not a deny-list, so these cover both the two failure cases it exists to
// catch — unset ASKTOTO_USERDATA, and one that resolves anywhere inside the real home directory,
// including the exact shapes a fixed deny-list missed — plus the two safe cases.
describe('assertSandboxedUserData', () => {
  const homeDir = '/Users/fake-dev'
  const tmpDir = '/private/var/folders/fake/T'

  it('throws when ASKTOTO_USERDATA is unset', () => {
    expect(() => assertSandboxedUserData({ userDataDir: '', homeDir, tmpDir })).toThrow(/ASKTOTO_USERDATA is unset/)
  })

  it('throws when ASKTOTO_USERDATA resolves inside the real Library/CloudStorage', () => {
    const userDataDir = join(homeDir, 'Library', 'CloudStorage', 'OneDrive-MantuGroup', 'Métis Meetings')
    expect(() => assertSandboxedUserData({ userDataDir, homeDir, tmpDir })).toThrow(/real home directory/)
  })

  it('throws when ASKTOTO_USERDATA resolves inside a business OneDrive root named "OneDrive - <Org>"', () => {
    // OneDriveCommercial on Windows is typically `<home>\OneDrive - <Org>`, which a deny-list keyed on
    // the exact segment "OneDrive" never matches.
    const userDataDir = join(homeDir, 'OneDrive - FakeCorp', 'stray-userdata')
    expect(() => assertSandboxedUserData({ userDataDir, homeDir, tmpDir })).toThrow(/real home directory/)
  })

  it('throws when ASKTOTO_USERDATA resolves inside the real (unpackaged) Métis userData profile', () => {
    const userDataDir = join(homeDir, 'Library', 'Application Support', 'asktoto-dev')
    expect(() => assertSandboxedUserData({ userDataDir, homeDir, tmpDir })).toThrow(/real home directory/)
  })

  it('does not throw for a directory under the OS temp dir', () => {
    const userDataDir = join(tmpDir, 'metis-qa-userdata-abc123')
    expect(assertSandboxedUserData({ userDataDir, homeDir, tmpDir })).toBe(true)
  })

  it('does not throw for an isolated directory outside the real home entirely', () => {
    expect(assertSandboxedUserData({ userDataDir: '/opt/metis-qa-userdata', homeDir, tmpDir })).toBe(true)
  })
})
