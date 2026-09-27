import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertAttachedAppIsSandboxed, assertSandboxedMeetingsFolder } from './sandbox-guard.mjs'

// W0-HERMETIC (M2-0190) — e2e-workflows.mjs and exhaustion-sim.mjs both call
// assertAttachedAppIsSandboxed() (the async wrapper below around the pure check in this describe block)
// right after connecting to the CDP-attached app, before either touches its settings/brain/API-keys on
// disk. This is an allow-list (under the OS temp dir), not a deny-list, so it accepts exactly one shape —
// resolving under `tmpDir` — and every other case, including one that resolves anywhere inside the real
// home directory and one that resolves outside the home directory entirely (which is not proof of
// isolation: an explicit settings.meetingsFolder can point anywhere), throws.
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

  it('throws for a resolvedMeetingsFolder outside the home directory entirely, e.g. a mounted volume', () => {
    // An explicit settings.meetingsFolder can point anywhere — a mounted volume, a network share, a
    // moved OneDrive root — so "outside home" alone is never proof that the rest of the profile (API
    // keys, brain index, every other setting) is sandboxed too. Concretely: e2e-workflows.mjs's
    // documented `--meetings=D:\fixtures` sets meetingsFolder on whatever profile is attached, and that
    // value is never restored by its SETTINGS_SNAPSHOT — so once set, it would defeat this guard forever
    // on that profile if "outside home" were treated as sandboxed.
    expect(() =>
      assertSandboxedMeetingsFolder({ meetingsFolder: '/Volumes/Data/Métis Meetings', homeDir, tmpDir })
    ).toThrow(/does not resolve under the OS temp/)
  })

  it('does not throw for a directory under the OS temp dir', () => {
    const meetingsFolder = join(tmpDir, 'metis-qa-userdata-abc123', 'Meetings')
    expect(() => assertSandboxedMeetingsFolder({ meetingsFolder, homeDir, tmpDir })).not.toThrow()
  })
})

describe('assertAttachedAppIsSandboxed', () => {
  const homeDir = '/Users/fake-dev'
  const tmpDir = '/private/var/folders/fake/T'

  // Stubs the global `window` the wrapper's page.evaluate callback closes over (window.toto.getSettings())
  // — this repo's vitest environment is 'node', so `window` does not exist unless stubbed — and returns a
  // minimal Playwright-page-shaped `evaluate` that just runs the callback, mirroring what a real CDP page
  // does for a callback with no arguments.
  function stubbedPage(resolvedMeetingsFolder: string) {
    vi.stubGlobal('window', { toto: { getSettings: async () => ({ resolvedMeetingsFolder }) } })
    return { evaluate: (fn: () => unknown) => Promise.resolve(fn()) }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('refuses when the attached app reports a resolvedMeetingsFolder outside the OS temp dir', async () => {
    const page = stubbedPage(join(homeDir, 'Library', 'CloudStorage', 'OneDrive-FakeCorp', 'Métis Meetings'))
    await expect(assertAttachedAppIsSandboxed(page, { homeDir, tmpDir })).rejects.toThrow(/real home directory/)
  })

  it('passes when the attached app reports a resolvedMeetingsFolder under the OS temp dir', async () => {
    const page = stubbedPage(join(tmpDir, 'metis-qa-userdata-abc123', 'Meetings'))
    await expect(assertAttachedAppIsSandboxed(page, { homeDir, tmpDir })).resolves.toBeUndefined()
  })
})
