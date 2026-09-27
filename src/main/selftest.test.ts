import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron')

// Suite 3 of the self-test drives the REAL settings layer (it points meetingsFolder at a scratch dir and
// turns encryption OFF to exercise the plaintext index), so a failure part-way through must not leave the
// profile it borrowed in that state. Both collaborators are mocked so the failure can be injected exactly
// where the finder saw it — between the setSettings() that borrows the profile and the one that gives it back.
const settingsState: Record<string, unknown> = {}
// Call order across the mocked collaborators below, shared by every describe block — lets a test assert
// that app.setPath('userData', …) happens strictly before the first settings access (M2-0004's acceptance).
const callOrder: string[] = []
vi.mock('./store', () => ({
  getSettings: vi.fn(() => {
    callOrder.push('getSettings')
    return { ...settingsState }
  }),
  setSettings: vi.fn((patch: Record<string, unknown>) => {
    callOrder.push('setSettings')
    Object.assign(settingsState, patch)
    return { ...settingsState }
  })
}))
vi.mock('./transcripts', () => ({
  saveMeeting: vi.fn(async () => {
    throw new Error('EACCES: meetings folder unwritable')
  }),
  ensureMeetingsFolder: vi.fn(),
  detectOneDrive: vi.fn(() => '')
}))

import { app } from 'electron'
import { redirectSelfTestUserData, runSelfTest } from './selftest'
import type { Settings } from '@shared/ipc'

/** The shared __mocks__/electron.ts app object has no setPath (nothing else in it needed one), so this
 *  adds it and wires it to getPath: app.getPath('userData') returns whatever the most recent
 *  app.setPath('userData', …) set, defaulting to `initial` — the same pattern cahe-edition.test.ts
 *  already uses (`app.setPath = (() => …) as typeof app.setPath`) for this exact mock. */
function mockRedirectableUserData(initial: string): void {
  let current = initial
  ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
    name === 'userData' ? current : join(current, name)
  )
  ;(app as unknown as { setPath: (name: string, path: string) => void }).setPath = vi.fn(
    (name: string, path: string) => {
      callOrder.push('setPath')
      if (name === 'userData') current = path
    }
  )
}

/** Mirrors index.ts's own ASKTOTO_USERDATA handling — the line right after redirectSelfTestUserData() —
 *  by applying whatever is in process.env.ASKTOTO_USERDATA to Electron's userData path. Self-test relies
 *  on that one existing line, not a second app.setPath call of its own, to take effect (M2-0004). */
function applyAskTotoUserData(): void {
  if (process.env.ASKTOTO_USERDATA) app.setPath('userData', process.env.ASKTOTO_USERDATA)
}

// devEnv() (imported by selftest.ts) reads process.env.ASKTOTO_SELFTEST and app.isPackaged directly, so
// every test that touches either — or the ASKTOTO_USERDATA redirectSelfTestUserData() now sets — must
// clean up, otherwise a later, unrelated test could inherit a planted env var or a packaged flag left on
// the shared mock.
afterEach(() => {
  delete process.env.ASKTOTO_SELFTEST
  delete process.env.ASKTOTO_USERDATA
  delete (app as { isPackaged?: boolean }).isPackaged
})

describe('redirectSelfTestUserData — the boot-time isolation gate (M2-0004)', () => {
  let priorUd: string

  beforeEach(() => {
    callOrder.length = 0
    priorUd = mkdtempSync(join(tmpdir(), 'asktoto-selftest-prior-'))
    mockRedirectableUserData(priorUd)
  })

  afterEach(() => {
    rmSync(priorUd, { recursive: true, force: true })
  })

  it('does not touch userData or ASKTOTO_USERDATA when ASKTOTO_SELFTEST is unset', () => {
    delete process.env.ASKTOTO_SELFTEST

    redirectSelfTestUserData()

    expect(callOrder).toEqual([])
    expect(process.env.ASKTOTO_USERDATA).toBeUndefined()
    expect(app.getPath('userData')).toBe(priorUd)
  })

  it('does not touch userData or ASKTOTO_USERDATA in a packaged build even with ASKTOTO_SELFTEST set', () => {
    // The threat this guards against: a persistent `setx ASKTOTO_SELFTEST out.json` plus a relaunch of a
    // shipped install must never redirect (and therefore never run self-test against) a real profile.
    process.env.ASKTOTO_SELFTEST = '/tmp/planted-selftest-out.json'
    ;(app as { isPackaged?: boolean }).isPackaged = true

    redirectSelfTestUserData()

    expect(callOrder).toEqual([])
    expect(process.env.ASKTOTO_USERDATA).toBeUndefined()
    expect(app.getPath('userData')).toBe(priorUd)
  })

  it('sets ASKTOTO_USERDATA to a newly created directory on an unpackaged run, leaving userData for the caller to apply', () => {
    process.env.ASKTOTO_SELFTEST = '/tmp/selftest-out.json'

    redirectSelfTestUserData()

    const redirected = process.env.ASKTOTO_USERDATA
    // Applying the redirect to Electron's userData is index.ts's existing ASKTOTO_USERDATA line's job —
    // one isolation mechanism, not two — so this function itself must never call app.setPath.
    expect(callOrder).toEqual([])
    expect(redirected).toBeTruthy()
    expect(redirected).not.toBe(priorUd)
    expect(existsSync(redirected!)).toBe(true)
    expect(app.getPath('userData')).toBe(priorUd)

    applyAskTotoUserData()

    expect(callOrder).toEqual(['setPath'])
    expect(app.getPath('userData')).toBe(redirected)

    rmSync(redirected!, { recursive: true, force: true })
  })
})

describe('redirectSelfTestUserData — implicit meetings store isolation (M2-0004)', () => {
  it("keeps the implicit meetings store under the self-test throwaway directory, never the owner's real profile", async () => {
    process.env.ASKTOTO_SELFTEST = '/tmp/selftest-out.json'

    redirectSelfTestUserData()
    const redirected = process.env.ASKTOTO_USERDATA
    expect(redirected).toBeTruthy()

    try {
      // Bypasses this file's own './transcripts' mock (saveMeeting/ensureMeetingsFolder/detectOneDrive
      // only, above) to exercise the REAL resolveMeetingsFolder() — the function that otherwise resolves
      // an empty meetingsFolder to the owner's real OneDrive/Documents 'Métis Meetings' folder and copies
      // legacy meetings into it (M2-0004).
      const { resolveMeetingsFolder } = await vi.importActual<typeof import('./transcripts')>('./transcripts')
      const folder = resolveMeetingsFolder({ meetingsFolder: '' } as Settings)
      expect(folder).toBe(join(redirected!, 'Métis Meetings'))
    } finally {
      rmSync(redirected!, { recursive: true, force: true })
    }
  })
})

describe('runSelfTest — borrowed profile state', () => {
  let ud: string
  let redirected: string

  beforeEach(() => {
    for (const k of Object.keys(settingsState)) delete settingsState[k]
    callOrder.length = 0
    ud = mkdtempSync(join(tmpdir(), 'asktoto-selftest-test-'))
    mockRedirectableUserData(ud)
    // Mirrors the real boot order (M2-0004): redirectSelfTestUserData() sets ASKTOTO_USERDATA, then
    // index.ts's existing ASKTOTO_USERDATA line applies it to userData, both before runSelfTest() is ever
    // called — so its refuse-to-run guard sees the throwaway directory it expects.
    process.env.ASKTOTO_SELFTEST = join(ud, 'out.json')
    redirectSelfTestUserData()
    applyAskTotoUserData()
    redirected = process.env.ASKTOTO_USERDATA!
  })

  afterEach(() => {
    rmSync(ud, { recursive: true, force: true })
    rmSync(redirected, { recursive: true, force: true })
  })

  it('MQA-167 — restores encryptTranscripts and the meetings folder when a suite throws mid-way', async () => {
    // Without the restore in a `finally`, a throw between the two setSettings calls leaves the profile on
    // encryptTranscripts:false pointing at a deleted scratch dir — every later meeting saved as cleartext.
    await runSelfTest(join(ud, 'out.json'))

    expect(settingsState.encryptTranscripts).toBe(true)
    expect(settingsState.meetingsFolder).toBe('')
  })

  it('leaves the throwaway userData directory in place once the run finishes', async () => {
    // On Windows this directory is the process's own cwd (index.ts chdir's into userData before
    // dispatching self-test) and holds Chromium's open lockfile, so deleting it here throws EBUSY/EPERM
    // after the report is already written — every run of the packaged app failed a `selftest` call on
    // Windows. Cleaning it up, if wanted, is the caller's job (it created the mkdtemp), not runSelfTest's.
    const throwaway = app.getPath('userData')

    await runSelfTest(join(ud, 'out.json'))

    expect(existsSync(throwaway)).toBe(true)
  })
})

describe('runSelfTest — dedicated throwaway userData (M2-0004)', () => {
  let realProfileDir: string
  let outDir: string
  let redirected: string | undefined
  const realSettings = JSON.stringify({ meetingsFolder: '/Users/real-owner/Real Meetings', temperature: 0.42 })
  const realManaged = JSON.stringify({ provider: 'real-provider' })

  beforeEach(() => {
    for (const k of Object.keys(settingsState)) delete settingsState[k]
    callOrder.length = 0
    // Stands in for the LIVE profile: what app.getPath('userData') already resolves to before self-test
    // runs, holding real settings.json / managed-config.json content a real launch would have written.
    realProfileDir = mkdtempSync(join(tmpdir(), 'asktoto-selftest-real-profile-'))
    writeFileSync(join(realProfileDir, 'settings.json'), realSettings)
    writeFileSync(join(realProfileDir, 'managed-config.json'), realManaged)
    outDir = mkdtempSync(join(tmpdir(), 'asktoto-selftest-out-'))
    mockRedirectableUserData(realProfileDir)
    redirected = undefined
  })

  afterEach(() => {
    rmSync(realProfileDir, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
    if (redirected) rmSync(redirected, { recursive: true, force: true })
  })

  it('refuses to run without redirectSelfTestUserData having redirected userData first, and touches nothing', async () => {
    // ASKTOTO_SELFTEST is deliberately left unset — redirectSelfTestUserData() is never called, so
    // userData still resolves to the stand-in live profile seeded above.
    await expect(runSelfTest(join(outDir, 'out.json'))).rejects.toThrow(/throwaway/)

    expect(callOrder).toEqual([]) // no getSettings/setSettings call ever happened
    expect(readFileSync(join(realProfileDir, 'settings.json'), 'utf8')).toBe(realSettings)
    expect(readFileSync(join(realProfileDir, 'managed-config.json'), 'utf8')).toBe(realManaged)
  })

  it("never reads or writes the real profile's settings.json / managed-config.json, even when a suite throws mid-run", async () => {
    // saveMeeting is mocked to throw (module mock above) — the mid-run failure the ticket asks for.
    process.env.ASKTOTO_SELFTEST = join(outDir, 'out.json')
    redirectSelfTestUserData()
    applyAskTotoUserData()
    redirected = process.env.ASKTOTO_USERDATA

    await runSelfTest(join(outDir, 'out.json'))

    expect(readFileSync(join(realProfileDir, 'settings.json'), 'utf8')).toBe(realSettings)
    expect(readFileSync(join(realProfileDir, 'managed-config.json'), 'utf8')).toBe(realManaged)
  })
})
