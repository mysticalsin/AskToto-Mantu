import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertSandboxedMeetingsFolder } from './sandbox-guard.mjs'

// W0-HERMETIC (M2-0190) — e2e-workflows.mjs and exhaustion-sim.mjs both call
// assertAttachedAppIsSandboxed() (this file's async wrapper around the pure check below) right after
// connecting to the CDP-attached app, before either touches its settings/brain/API-keys on disk. This is
// an allow-list (under the OS temp dir, or outside the home directory entirely), not a deny-list, so
// these cover both failure cases it exists to catch — no resolvedMeetingsFolder reported, and one that
// resolves anywhere inside the real home directory, including shapes a fixed deny-list missed — plus the
// two safe cases.
describe('assertSandboxedMeetingsFolder', () => {
  const homeDir = '/Users/fake-dev'
  const tmpDir = '/private/var/folders/fake/T'

  it('throws when the attached app reports no resolvedMeetingsFolder', () => {
    expect(() => assertSandboxedMeetingsFolder({ meetingsFolder: '', homeDir, tmpDir })).toThrow(
      /reported no resolvedMeetingsFolder/
    )
  })

  it('throws when resolvedMeetingsFolder resolves inside the real Library/CloudStorage', () => {
    const meetingsFolder = join(homeDir, 'Library', 'CloudStorage', 'OneDrive-FakeCorp', 'Métis Meetings')
    expect(() => assertSandboxedMeetingsFolder({ meetingsFolder, homeDir, tmpDir })).toThrow(/real home directory/)
  })

  it('throws when resolvedMeetingsFolder resolves inside a business OneDrive root named "OneDrive - <Org>"', () => {
    // OneDriveCommercial on Windows is typically `<home>\OneDrive - <Org>`, which a deny-list keyed on
    // the exact segment "OneDrive" never matches.
    const meetingsFolder = join(homeDir, 'OneDrive - FakeCorp', 'stray-meetings')
    expect(() => assertSandboxedMeetingsFolder({ meetingsFolder, homeDir, tmpDir })).toThrow(/real home directory/)
  })

  it('throws when resolvedMeetingsFolder resolves inside the real (unpackaged) Métis userData profile', () => {
    const meetingsFolder = join(homeDir, 'Library', 'Application Support', 'asktoto-dev', 'Meetings')
    expect(() => assertSandboxedMeetingsFolder({ meetingsFolder, homeDir, tmpDir })).toThrow(/real home directory/)
  })

  it('still throws (as "inside home") for a real subdirectory of home whose name merely starts with ".."', () => {
    // Regression for a bare `rel.startsWith('..')` string check: a directory literally named "..foo"
    // directly under home is a real subdirectory, not a `..` traversal segment, so `path.relative(home,
    // child)` returns the non-traversal string "..foo/Meetings" — which still starts with the two
    // characters ".." even though it means something else. A string-prefix check reads that as "outside
    // home" (safe) and lets a real hazard through; only comparing against the exact `..` segment
    // (`rel === '..' || rel.startsWith('..' + sep)`) tells the two apart.
    const meetingsFolder = join(homeDir, '..foo', 'Meetings')
    expect(() => assertSandboxedMeetingsFolder({ meetingsFolder, homeDir, tmpDir })).toThrow(/real home directory/)
  })

  it('does not throw for a directory under the OS temp dir', () => {
    const meetingsFolder = join(tmpDir, 'metis-qa-userdata-abc123', 'Meetings')
    expect(assertSandboxedMeetingsFolder({ meetingsFolder, homeDir, tmpDir })).toBe(true)
  })

  it('does not throw for an isolated directory outside the real home entirely', () => {
    expect(assertSandboxedMeetingsFolder({ meetingsFolder: '/opt/metis-qa-userdata/Meetings', homeDir, tmpDir })).toBe(
      true
    )
  })
})
