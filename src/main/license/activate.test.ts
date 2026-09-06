import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from 'electron'
import { LICENSE_ACTIVATION_OPEN } from '@shared/license-types'
import type { Settings } from '@shared/ipc'

vi.mock('electron')

let testSettings: Settings
vi.mock('../store', () => ({
  getSettings: () => testSettings,
  setSettings: (patch: Partial<Settings>) => {
    testSettings = { ...testSettings, ...patch }
    return testSettings
  }
}))

import { generateOperatorLicense } from '@shared/operator-license'
import { activate, identitySnapshot, resetRegisterAttemptForTests, status } from './activate'
import { readInstallIdentity } from './install'

describe('member-pass activate foundation', () => {
  let ud: string

  beforeEach(() => {
    ud = mkdtempSync(join(tmpdir(), 'metis-activate-'))
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((n: string) => (n === 'userData' ? ud : join(ud, n)))
    ;(app.getVersion as ReturnType<typeof vi.fn>).mockReturnValue('1.6.6-test')
    testSettings = { licenseServerUrl: '', operatorIngestSecret: 'operator-ingest-test-secret' } as Settings
    resetRegisterAttemptForTests()
  })

  afterEach(() => {
    rmSync(ud, { recursive: true, force: true })
  })

  it('ships with LICENSE_ACTIVATION_OPEN=false', () => {
    expect(LICENSE_ACTIVATION_OPEN).toBe(false)
  })

  it('activate(key) runs the real client path and returns ActivationUnavailable', async () => {
    const r = await activate('ATK-7QHM2K9X3VBN8ZC1FGJ0')
    expect(r.ok).toBe(false)
    expect(r.error).toBe('activation_unavailable')
    expect(r.status.state).toBe('unlicensed')
    expect(r.status.edition).toBe('personal')
    expect(r.status.activationOpen).toBe(false)
  })

  it('never pretends success and never writes a licensed cache while closed', async () => {
    await activate('ATK-7QHM2K9X3VBN8ZC1FGJ0')
    const s = status()
    expect(s.state).toBe('unlicensed')
    expect(s.source).toBe('none')
  })

  it('activates an Operator-generated license and rejects expiry', async () => {
    const minted = await generateOperatorLicense('operator-ingest-test-secret', {
      days: 30,
      now: Date.now(),
      jti: 'aabbccddeeff0011'
    })
    const r = await activate(minted.token)
    expect(r.ok).toBe(true)
    expect(r.status.state).toBe('licensed')
    expect(r.status.edition).toBe('pro')
    expect(r.status.source).toBe('operator')
    expect(r.status.expiresAt).toBe(minted.claims.exp * 1000)
    expect(status().state).toBe('licensed')

    const expired = await generateOperatorLicense('operator-ingest-test-secret', {
      days: 1,
      now: Date.now() - 48 * 60 * 60 * 1000,
      jti: '1122334455667788'
    })
    const bad = await activate(expired.token)
    expect(bad.ok).toBe(false)
    expect(bad.error).toBe('expired')
    expect(status().state).toBe('licensed')
  })

  it('identity snapshot is local, fast, and honest about a pending member number', () => {
    const snap = identitySnapshot()
    expect(snap.memberNumber).toBeNull()
    expect(snap.memberNumberLabel).toBe('pending')
    expect(snap.installedAtLabel).toMatch(/^Installed /)
    expect(snap.serialDisplay.length).toBeGreaterThan(0)
    expect(snap.license.state).toBe('unlicensed')
    const again = readInstallIdentity(ud)
    expect(again.installId).toBe(snap.installId)
    expect(again.memberNumber).toBeNull()
  })
})
