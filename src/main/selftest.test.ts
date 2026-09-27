import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron')

// Suite 3 of the self-test drives the REAL settings layer (it points meetingsFolder at a scratch dir and
// turns encryption OFF to exercise the plaintext index), so a failure part-way through must not leave the
// profile it borrowed in that state. Both collaborators are mocked so the failure can be injected exactly
// where the finder saw it — between the setSettings() that borrows the profile and the one that gives it back.
const settingsState: Record<string, unknown> = {}
// Call order across the mocked collaborators below, shared by both describe blocks — lets a test assert
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
import { runSelfTest } from './selftest'

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

describe('runSelfTest — borrowed profile state', () => {
  let ud: string

  beforeEach(() => {
    for (const k of Object.keys(settingsState)) delete settingsState[k]
    callOrder.length = 0
    ud = mkdtempSync(join(tmpdir(), 'asktoto-selftest-test-'))
    mockRedirectableUserData(ud)
  })

  afterEach(() => {
    rmSync(ud, { recursive: true, force: true })
  })

  it('MQA-167 — restores encryptTranscripts and the meetings folder when a suite throws mid-way', async () => {
    // Without the restore in a `finally`, a throw between the two setSettings calls leaves the profile on
    // encryptTranscripts:false pointing at a deleted scratch dir — every later meeting saved as cleartext.
    await runSelfTest(join(ud, 'out.json'))

    expect(settingsState.encryptTranscripts).toBe(true)
    expect(settingsState.meetingsFolder).toBe('')
  })
})

describe('runSelfTest — dedicated throwaway userData (M2-0004)', () => {
  let realProfileDir: string
  let outDir: string
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
  })

  afterEach(() => {
    rmSync(realProfileDir, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
  })

  it("never reads or writes the real profile's settings.json / managed-config.json, even when a suite throws mid-run", async () => {
    // saveMeeting is mocked to throw (module mock above) — the mid-run failure the ticket asks for.
    await runSelfTest(join(outDir, 'out.json'))

    expect(readFileSync(join(realProfileDir, 'settings.json'), 'utf8')).toBe(realSettings)
    expect(readFileSync(join(realProfileDir, 'managed-config.json'), 'utf8')).toBe(realManaged)
  })

  it('redirects userData to a fresh directory strictly before the first settings read', async () => {
    await runSelfTest(join(outDir, 'out.json'))

    expect(callOrder[0]).toBe('setPath')
    expect(callOrder.indexOf('setPath')).toBeLessThan(callOrder.indexOf('getSettings'))
  })
})
