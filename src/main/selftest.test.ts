import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron')

// Suite 3 of the self-test drives the REAL settings layer (it points meetingsFolder at a scratch dir and
// turns encryption OFF to exercise the plaintext index), so a failure part-way through must not leave the
// profile it borrowed in that state. Both collaborators are mocked so the failure can be injected exactly
// where the finder saw it — between the setSettings() that borrows the profile and the one that gives it back.
const settingsState: Record<string, unknown> = {}
vi.mock('./store', () => ({
  getSettings: vi.fn(() => ({ ...settingsState })),
  setSettings: vi.fn((patch: Record<string, unknown>) => {
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

describe('runSelfTest — borrowed profile state', () => {
  let ud: string

  beforeEach(() => {
    for (const k of Object.keys(settingsState)) delete settingsState[k]
    ud = mkdtempSync(join(tmpdir(), 'asktoto-selftest-test-'))
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'userData' ? ud : join(ud, name)
    )
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
