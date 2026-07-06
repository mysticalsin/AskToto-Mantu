import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import type { Settings } from '@shared/ipc'

vi.mock('electron')

// license.ts only ever touches settings via getSettings()/setSettings() — stub the store entirely so
// these tests never hit the real userData settings.json, and so setSettings mutations are observable.
let testSettings: Settings
const setSettingsSpy = vi.fn((patch: Partial<Settings>) => {
  testSettings = { ...testSettings, ...patch }
  return testSettings
})
vi.mock('./store', () => ({
  getSettings: () => testSettings,
  setSettings: (patch: Partial<Settings>) => setSettingsSpy(patch)
}))

import { activateLicense, heartbeat, checkLicenseGrace, getMachineId } from './license'

const DAY = 24 * 60 * 60 * 1000

function baseSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    licenseServerUrl: '',
    licenseKey: '',
    licenseCompanyName: '',
    licenseSeatCap: 0,
    licenseExpiresAt: null,
    licenseValid: false,
    licenseLastValidatedAt: 0,
    licenseGateEnabled: false,
    ...overrides
  } as Settings
}

function jsonResponse(body: unknown): Response {
  return { json: () => Promise.resolve(body) } as unknown as Response
}

describe('license.ts — phone-home activation', () => {
  let ud: string
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    ud = mkdtempSync(join(tmpdir(), 'asktoto-license-test-'))
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((n: string) =>
      n === 'userData' ? ud : join(ud, n)
    )
    testSettings = baseSettings()
    setSettingsSpy.mockClear()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    rmSync(ud, { recursive: true, force: true })
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  describe('getMachineId', () => {
    it('persists the same id across calls (not derived from hostname/username)', () => {
      const first = getMachineId()
      const second = getMachineId()
      expect(second).toBe(first)
      expect(readFileSync(join(ud, 'machine-id.txt'), 'utf8').trim()).toBe(first)
    })
  })

  describe('activateLicense', () => {
    it('success persists settings', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ ok: true, companyName: 'Acme', seatCap: 5, seatsUsed: 2, expiresAt: 1_800_000_000_000 })
      )

      const r = await activateLicense('https://license.acme.test', 'KEY-123')

      expect(r.ok).toBe(true)
      expect(testSettings.licenseValid).toBe(true)
      expect(testSettings.licenseServerUrl).toBe('https://license.acme.test')
      expect(testSettings.licenseKey).toBe('KEY-123')
      expect(testSettings.licenseCompanyName).toBe('Acme')
      expect(testSettings.licenseSeatCap).toBe(5)
      expect(testSettings.licenseExpiresAt).toBe(1_800_000_000_000)
      expect(testSettings.licenseLastValidatedAt).toBeGreaterThan(0)
      // The activate call posts to /activate with a stable machineId — never derived from hostname.
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe('https://license.acme.test/activate')
      const body = JSON.parse((init as RequestInit).body as string)
      expect(body.licenseKey).toBe('KEY-123')
      expect(body.machineId).toBe(getMachineId())
    })

    it('failure does not clear existing valid state', async () => {
      testSettings = baseSettings({
        licenseValid: true,
        licenseServerUrl: 'https://license.acme.test',
        licenseKey: 'GOOD-KEY',
        licenseCompanyName: 'Acme',
        licenseSeatCap: 3,
        licenseLastValidatedAt: Date.now()
      })
      fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: 'invalid' }))

      const r = await activateLicense('https://license.acme.test', 'TYPO-KEY')

      expect(r.ok).toBe(false)
      expect(r.error).toBe('invalid')
      // A bad re-activation attempt must never touch settings — the prior working activation survives untouched.
      expect(setSettingsSpy).not.toHaveBeenCalled()
      expect(testSettings.licenseValid).toBe(true)
      expect(testSettings.licenseKey).toBe('GOOD-KEY')
    })

    it('a network failure returns error:"network" and leaves settings untouched', async () => {
      testSettings = baseSettings({ licenseValid: true, licenseKey: 'GOOD-KEY' })
      fetchMock.mockRejectedValue(new Error('offline'))

      const r = await activateLicense('https://license.acme.test', 'ANY-KEY')

      expect(r).toEqual({ ok: false, error: 'network' })
      expect(setSettingsSpy).not.toHaveBeenCalled()
      expect(testSettings.licenseKey).toBe('GOOD-KEY')
    })
  })

  describe('checkLicenseGrace', () => {
    it('with the gate disabled, always allows (no network call)', () => {
      testSettings = baseSettings({ licenseGateEnabled: false, licenseValid: false })

      const r = checkLicenseGrace()

      expect(r).toEqual({ allowed: true })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('within the 7-day grace, allows without a network call', () => {
      testSettings = baseSettings({
        licenseGateEnabled: true,
        licenseValid: true,
        licenseLastValidatedAt: Date.now() - 1 * DAY
      })

      const r = checkLicenseGrace()

      expect(r).toEqual({ allowed: true })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('past the 30-day hard cap with no successful re-validation, blocks', () => {
      testSettings = baseSettings({
        licenseGateEnabled: true,
        licenseValid: true,
        licenseLastValidatedAt: Date.now() - 31 * DAY
      })

      const r = checkLicenseGrace()

      expect(r).toEqual({ allowed: false, reason: 'expired_grace' })
    })

    it('with no activation at all, blocks with reason not_activated', () => {
      testSettings = baseSettings({ licenseGateEnabled: true, licenseValid: false })

      const r = checkLicenseGrace()

      expect(r).toEqual({ allowed: false, reason: 'not_activated' })
    })

    it('between 7 and 30 days, fires a background heartbeat but still allows immediately', async () => {
      testSettings = baseSettings({
        licenseGateEnabled: true,
        licenseValid: true,
        licenseServerUrl: 'https://license.acme.test',
        licenseKey: 'GOOD-KEY',
        licenseLastValidatedAt: Date.now() - 10 * DAY
      })
      fetchMock.mockResolvedValue(jsonResponse({ ok: true, companyName: 'Acme', seatCap: 5, seatsUsed: 1, expiresAt: null }))

      const r = checkLicenseGrace()

      expect(r).toEqual({ allowed: true }) // never blocks on the background call
      await Promise.resolve().then(() => Promise.resolve()) // flush the fire-and-forget heartbeat
      expect(fetchMock).toHaveBeenCalled()
    })
  })

  describe('heartbeat', () => {
    it('a network failure does not flip licenseValid to false', async () => {
      testSettings = baseSettings({
        licenseValid: true,
        licenseServerUrl: 'https://license.acme.test',
        licenseKey: 'GOOD-KEY',
        licenseLastValidatedAt: Date.now() - 10 * DAY
      })
      fetchMock.mockRejectedValue(new Error('offline'))

      const r = await heartbeat()

      expect(r).toEqual({ ok: false, error: 'network' })
      expect(testSettings.licenseValid).toBe(true)
    })

    it('an explicit revoked response flips licenseValid to false', async () => {
      testSettings = baseSettings({
        licenseValid: true,
        licenseServerUrl: 'https://license.acme.test',
        licenseKey: 'GOOD-KEY',
        licenseLastValidatedAt: Date.now() - 10 * DAY
      })
      fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: 'revoked' }))

      const r = await heartbeat()

      expect(r).toEqual({ ok: false, error: 'revoked' })
      expect(testSettings.licenseValid).toBe(false)
    })

    it('an explicit expired response also flips licenseValid to false', async () => {
      testSettings = baseSettings({
        licenseValid: true,
        licenseServerUrl: 'https://license.acme.test',
        licenseKey: 'GOOD-KEY',
        licenseLastValidatedAt: Date.now() - 10 * DAY
      })
      fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: 'expired' }))

      const r = await heartbeat()

      expect(r).toEqual({ ok: false, error: 'expired' })
      expect(testSettings.licenseValid).toBe(false)
    })
  })
})
