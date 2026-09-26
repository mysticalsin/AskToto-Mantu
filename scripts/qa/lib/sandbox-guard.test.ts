import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertSandboxedUserData } from './sandbox-guard.mjs'

// W0-HERMETIC (M2-0190) — e2e-workflows.mjs calls assertSandboxedUserData() before it touches a
// CDP-connected app's settings/brain on disk. These are the two failure cases it exists to catch
// (unset ASKTOTO_USERDATA; one that resolves into the real synced meetings store) plus the safe case,
// exercised directly against the function rather than through the full harness.
describe('assertSandboxedUserData', () => {
  const homeDir = '/Users/fake-dev'

  it('throws when ASKTOTO_USERDATA is unset', () => {
    expect(() => assertSandboxedUserData({ userDataDir: '', homeDir })).toThrow(/ASKTOTO_USERDATA is unset/)
  })

  it('throws when ASKTOTO_USERDATA resolves inside the real Library/CloudStorage', () => {
    const userDataDir = join(homeDir, 'Library', 'CloudStorage', 'OneDrive-MantuGroup', 'Métis Meetings')
    expect(() => assertSandboxedUserData({ userDataDir, homeDir })).toThrow(/real synced meetings store/)
  })

  it('throws when ASKTOTO_USERDATA resolves inside the real OneDrive folder directly', () => {
    const userDataDir = join(homeDir, 'OneDrive', 'stray-userdata')
    expect(() => assertSandboxedUserData({ userDataDir, homeDir })).toThrow(/real synced meetings store/)
  })

  it('does not throw for an isolated directory outside the real home entirely', () => {
    expect(assertSandboxedUserData({ userDataDir: '/tmp/metis-qa-userdata-abc123', homeDir })).toBe(true)
  })

  it('does not throw for a path that merely starts with "OneDrive" as a string, not as a real segment', () => {
    // .../OneDriveBackup/foo must not be mistaken for a path under .../OneDrive.
    const userDataDir = join(homeDir, 'OneDriveBackup', 'foo')
    expect(assertSandboxedUserData({ userDataDir, homeDir })).toBe(true)
  })
})
