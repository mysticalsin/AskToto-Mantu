import { describe, it, expect, vi } from 'vitest'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, sep } from 'node:path'

// MQA-348 — the unit suite must never resolve the developer's real profile. Brain-ingest and
// update-persistence tests call resolveMeetingsFolder() without a meetings folder, which falls back to
// detectOneDrive() (derived from the home directory) and then copies the pre-rebrand "AskToto Meetings"
// sibling into "Métis Meetings" — on a developer Mac that meant writing into the real OneDrive meeting
// store, and a cloud-only placeholder hung the whole run inside a synchronous copyFileSync. vitest.config
// now hands every worker a fresh temporary home; these assertions keep that isolation from quietly
// disappearing.
vi.mock('electron')

import { app } from 'electron'
import { detectOneDrive, resolveMeetingsFolder } from './transcripts'
import type { Settings } from '@shared/ipc'

type EnvSnapshot = { present: boolean; value: string | undefined }

function snapshotEnv(name: string): EnvSnapshot {
  return {
    present: Object.prototype.hasOwnProperty.call(process.env, name),
    value: process.env[name]
  }
}

function restoreEnv(name: string, snapshot: EnvSnapshot): void {
  if (snapshot.present) process.env[name] = snapshot.value!
  else delete process.env[name]
}

describe('MQA-348 — test workers run under a hermetic home', () => {
  it('MQA-348 — homedir() is the fresh per-run test home, not the real user profile', () => {
    const home = homedir()
    expect(process.env.METIS_TEST_HOME).toBeTruthy()
    expect(home).toBe(process.env.METIS_TEST_HOME)
    expect(basename(home)).toMatch(/^metis-test-home-/)
    expect(existsSync(join(home, 'Library', 'CloudStorage'))).toBe(false)
    expect(existsSync(join(home, 'OneDrive'))).toBe(false)
  })

  it('MQA-348 — the default meeting store cannot resolve into a real OneDrive folder', () => {
    const inheritedUserData = snapshotEnv('ASKTOTO_USERDATA')
    try {
      delete process.env.ASKTOTO_USERDATA
      expect(detectOneDrive()).toBe('')
      const folder = resolveMeetingsFolder({ meetingsFolder: '' } as Settings)
      // W0-HERMETIC: app.getPath('documents') is derived from ASKTOTO_TEST_SANDBOX_ROOT (see
      // __mocks__/electron.ts), not a fixed /tmp literal — asserting the fixed string would silently pass
      // even if a future change let two concurrent runs collide on the same hardcoded path.
      expect(process.env.ASKTOTO_TEST_SANDBOX_ROOT).toBeTruthy()
      expect(folder).toBe(join(process.env.ASKTOTO_TEST_SANDBOX_ROOT!, 'documents', 'Métis Meetings'))
      expect(folder).not.toMatch(/CloudStorage|OneDrive/)
    } finally {
      restoreEnv('ASKTOTO_USERDATA', inheritedUserData)
    }
  })

  it('MQA-348 — an explicit QA userData override stays inside the worker sandbox and bypasses default resolution', () => {
    const inheritedUserData = snapshotEnv('ASKTOTO_USERDATA')
    let qaUserData: string | undefined
    try {
      const sandboxRoot = process.env.ASKTOTO_TEST_SANDBOX_ROOT
      expect(sandboxRoot).toBeTruthy()
      const canonicalSandboxRoot = realpathSync(sandboxRoot!)
      qaUserData = mkdtempSync(join(canonicalSandboxRoot, 'qa-userdata-'))
      process.env.ASKTOTO_USERDATA = qaUserData

      const canonicalQaUserData = realpathSync(qaUserData)
      const qaRelativeToSandbox = relative(canonicalSandboxRoot, canonicalQaUserData)
      expect(qaRelativeToSandbox).not.toBe('')
      expect(qaRelativeToSandbox).not.toBe('..')
      expect(qaRelativeToSandbox.startsWith(`..${sep}`)).toBe(false)
      expect(isAbsolute(qaRelativeToSandbox)).toBe(false)

      const getPathMock = app.getPath as ReturnType<typeof vi.fn>
      const getPathCallsBeforeResolution = getPathMock.mock.calls.length
      const folder = resolveMeetingsFolder({ meetingsFolder: '' } as Settings)

      expect(folder).toBe(join(qaUserData, 'Métis Meetings'))
      expect(process.env.ASKTOTO_USERDATA).toBe(qaUserData)
      expect(getPathMock).toHaveBeenCalledTimes(getPathCallsBeforeResolution)
    } finally {
      restoreEnv('ASKTOTO_USERDATA', inheritedUserData)
      if (qaUserData) rmSync(qaUserData, { recursive: true, force: true })
    }
  })

  it('MQA-348 — the Windows OneDrive env vars detectOneDrive() trusts are inert under the sandbox', () => {
    // The branch that only ever runs on the Windows CI runner, where nobody would otherwise notice it
    // silently doing the wrong thing — cheap insurance against a future edit to hermeticHomeEnv.
    expect(process.env.OneDrive).toBe('')
    expect(process.env.OneDriveCommercial).toBe('')
    expect(process.env.OneDriveConsumer).toBe('')
  })
})
