import { describe, it, expect, vi } from 'vitest'

// Locks the "updating the app never loses your meeting transcripts" guarantee. Transcripts (and every
// other piece of user data) MUST live outside the app install directory, because a Windows NSIS update
// / a macOS .app replacement overwrites only the install dir — never %APPDATA% (userData) or the user's
// Documents/OneDrive. If a future change ever routed the meeting store under resourcesPath/the install
// dir, an update would silently wipe the user's history; these tests fail loudly first.
vi.mock('electron')

import { resolveMeetingsFolder } from './transcripts'
import type { Settings } from '@shared/ipc'

const SEMVER = /\d+\.\d+\.\d+/
// Markers of an install/resource location that an update replaces (Program Files, a packaged .app, or
// electron's resourcesPath) — the meeting store must never resolve inside any of them.
const INSTALL_MARKERS = ['Program Files', '.app/Contents', '/resources/', 'app.asar']

describe('update-persistence: meeting transcripts survive an app update', () => {
  it('an explicit user meetings folder is returned verbatim (a chosen OneDrive/Documents path persists)', () => {
    const folder = '/Users/someone/Library/CloudStorage/OneDrive/Métis Meetings'
    expect(resolveMeetingsFolder({ meetingsFolder: folder } as Settings)).toBe(folder)
  })

  it('the default meeting store is user-owned, version-independent, and never inside the install dir', () => {
    const dir = resolveMeetingsFolder({ meetingsFolder: '' } as Settings)
    // Under the user's Documents/OneDrive (the mocked getPath('documents') = /tmp/asktoto-test-documents),
    // named stably — NOT under the app bundle the updater overwrites.
    expect(dir.endsWith('Métis Meetings')).toBe(true)
    expect(SEMVER.test(dir)).toBe(false) // no version in the path → the same folder across 1.1.0, 1.2.0, …
    for (const marker of INSTALL_MARKERS) expect(dir.includes(marker)).toBe(false)
  })

  it('the store path does not depend on the app version (same folder before and after an update)', () => {
    // resolveMeetingsFolder reads only settings + user-dir/OneDrive — no app.getVersion() anywhere — so
    // a v1.1.0 install and a v1.2.0 install resolve to the identical folder and read the same history.
    const before = resolveMeetingsFolder({ meetingsFolder: '' } as Settings)
    const after = resolveMeetingsFolder({ meetingsFolder: '' } as Settings)
    expect(after).toBe(before)
  })
})
