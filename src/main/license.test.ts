import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createPrivateKey, sign } from 'node:crypto'
import { app } from 'electron'
import type { Settings } from '@shared/ipc'
import { tagAsDemo } from '@shared/demo-guard'
import { devLeasePublicKeyForTests } from './license-lease-key'
import { TRIAL_DAYS, TRIAL_MS } from './license-trial'

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

import {
  activateLicense,
  heartbeat,
  checkLicenseGrace,
  getMachineId,
  normalizeServerUrl,
  verifyLease,
  noteQualifyingUse,
  licenseDisplayStatus,
  fetchLicenseConfig
} from './license'

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
    licenseLease: '',
    trialStartedAt: null,
    ...overrides
  } as Settings
}

// Test-only fixture — the PRIVATE half of the DEV_LEASE_PUBLIC_KEY bundled in license-lease-key.ts (same
// fixture license-lease-verify.test.ts uses). Only ever used here to sign a lease so checkLicenseGrace's
// "prefer a valid lease" branch can be exercised against a genuinely-verifiable token.
const FIXTURE_PRIVATE_KEY_PEM = Buffer.from(
  'LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tCk1DNENBUUF3QlFZREsyVndCQ0lFSU5CMFVLNFVYU0xuNm1YSU9kaE45SWc1WW43QzFjVlpHMUpvdzJVcjYyeE0KLS0tLS1FTkQgUFJJVkFURSBLRVktLS0tLQo=',
  'base64'
).toString('utf8')

const LEASE_KEY = 'ATK-TEST1234'

function signTestLease(overrides: Partial<Record<string, unknown>> = {}): string {
  const now = Date.now()
  const payload = {
    licenseKey: LEASE_KEY,
    // Bound to this test profile's machine id (license.ts refuses a lease minted for another device).
    machineId: getMachineId(),
    companyName: 'Acme Corp',
    seatCap: 5,
    issuedAt: now,
    notAfter: now + 14 * DAY,
    ...overrides
  }
  const privateKey = createPrivateKey(FIXTURE_PRIVATE_KEY_PEM)
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const signature = sign(null, Buffer.from(payloadB64, 'utf8'), privateKey)
  return `${payloadB64}.${signature.toString('base64url')}`
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

  describe('normalizeServerUrl', () => {
    it('adds a scheme to a scheme-less address so fetch does not reject it: http for loopback, https elsewhere', () => {
      expect(normalizeServerUrl('127.0.0.1:8420')).toBe('http://127.0.0.1:8420')
      expect(normalizeServerUrl('localhost:8420')).toBe('http://localhost:8420')
      expect(normalizeServerUrl('192.168.1.50:8420')).toBe('https://192.168.1.50:8420')
      expect(normalizeServerUrl('licenses.acme.com')).toBe('https://licenses.acme.com')
    })
    it('preserves an explicit scheme and strips trailing slashes and whitespace', () => {
      expect(normalizeServerUrl('https://license.acme.com/')).toBe('https://license.acme.com')
      expect(normalizeServerUrl('  http://127.0.0.1:8420//  ')).toBe('http://127.0.0.1:8420')
      expect(normalizeServerUrl('HTTPS://Acme.com')).toBe('HTTPS://Acme.com')
    })
    it('refuses plaintext http to a non-loopback host and any metadata / link-local address', () => {
      expect(normalizeServerUrl('http://licenses.acme.com')).toBe('')
      expect(normalizeServerUrl('http://192.168.1.50:8420')).toBe('')
      expect(normalizeServerUrl('https://169.254.169.254/latest')).toBe('')
      expect(normalizeServerUrl('169.254.10.7')).toBe('')
      expect(normalizeServerUrl('https://metadata.google.internal')).toBe('')
      expect(normalizeServerUrl('')).toBe('')
    })
    it('a refused server address reads as a network failure and never posts the key', async () => {
      testSettings = baseSettings()
      expect(await activateLicense('http://licenses.acme.com', 'KEY-123')).toEqual({ ok: false, error: 'network' })
      testSettings = baseSettings({ licenseServerUrl: 'http://169.254.169.254', licenseKey: 'KEY-123', licenseValid: true })
      expect(await heartbeat()).toEqual({ ok: false, error: 'network' })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(testSettings.licenseValid).toBe(true)
    })
    it('activation normalizes a scheme-less URL before fetching AND persists the normalized form', async () => {
      testSettings = baseSettings()
      fetchMock.mockResolvedValue(jsonResponse({ ok: true, companyName: 'Acme', seatCap: 5, seatsUsed: 1, expiresAt: null }))
      await activateLicense('127.0.0.1:8420', ' KEY-123 ')
      expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8420/activate', expect.anything())
      expect(testSettings.licenseServerUrl).toBe('http://127.0.0.1:8420')
      expect(testSettings.licenseKey).toBe('KEY-123') // trimmed
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

    it('a clock set backwards (validation stamped in the future) does NOT grant infinite grace', () => {
      // The exploit: roll the system clock back so lastValidatedAt is in the future, making age
      // negative and (before the fix) always < GRACE_MS. Must block, not bypass.
      testSettings = baseSettings({
        licenseGateEnabled: true,
        licenseValid: true,
        licenseServerUrl: 'https://license.acme.test',
        licenseKey: 'GOOD-KEY',
        licenseLastValidatedAt: Date.now() + 400 * DAY
      })
      fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: 'revoked' }))

      const r = checkLicenseGrace()

      expect(r).toEqual({ allowed: false, reason: 'expired_grace' })
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

  // The license:gate IPC handler (main/index.ts) constructs its verdict as
  // `{ gateEnabled: getSettings().licenseGateEnabled, ...checkLicenseGrace() }` — deliberately NOT
  // behind requireAuth(), since it's what App.tsx's boot gate reads before SSO even resolves. These
  // pin that exact merged shape, since it's the contract LicenseGate.tsx (renderer) depends on.
  describe('gate verdict shape (mirrors the license:gate IPC handler)', () => {
    it('gate disabled -> allowed, with gateEnabled:false and no fetch', () => {
      testSettings = baseSettings({ licenseGateEnabled: false })

      const verdict = { gateEnabled: testSettings.licenseGateEnabled, ...checkLicenseGrace() }

      expect(verdict).toEqual({ gateEnabled: false, allowed: true })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('gate on, valid within grace -> allowed, with gateEnabled:true', () => {
      testSettings = baseSettings({
        licenseGateEnabled: true,
        licenseValid: true,
        licenseLastValidatedAt: Date.now() - 1 * DAY
      })

      const verdict = { gateEnabled: testSettings.licenseGateEnabled, ...checkLicenseGrace() }

      expect(verdict).toEqual({ gateEnabled: true, allowed: true })
    })

    it('gate on, never activated -> blocked with reason not_activated', () => {
      testSettings = baseSettings({ licenseGateEnabled: true, licenseValid: false })

      const verdict = { gateEnabled: testSettings.licenseGateEnabled, ...checkLicenseGrace() }

      expect(verdict).toEqual({ gateEnabled: true, allowed: false, reason: 'not_activated' })
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

    it('a revoke also drops the cached lease, so the gate closes on the next check even while online', async () => {
      testSettings = baseSettings({
        licenseGateEnabled: true,
        licenseValid: true,
        licenseServerUrl: 'https://license.acme.test',
        licenseKey: LEASE_KEY,
        licenseLastValidatedAt: Date.now() - 1 * DAY,
        licenseLease: signTestLease({ notAfter: Date.now() + 10 * DAY })
      })
      expect(checkLicenseGrace().allowed).toBe(true)
      fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: 'revoked' }))

      await heartbeat()

      expect(testSettings.licenseLease).toBe('')
      expect(checkLicenseGrace()).toEqual({ allowed: false, reason: 'not_activated' })
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

    it('a not_activated response (admin freed this seat) flips licenseValid to false', async () => {
      testSettings = baseSettings({
        licenseValid: true,
        licenseServerUrl: 'https://license.acme.test',
        licenseKey: 'GOOD-KEY',
        licenseLastValidatedAt: Date.now() - 10 * DAY
      })
      fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: 'not_activated' }))

      const r = await heartbeat()

      expect(r).toEqual({ ok: false, error: 'not_activated' })
      expect(testSettings.licenseValid).toBe(false)
    })

    it('an invalid response (license deleted) flips licenseValid to false', async () => {
      testSettings = baseSettings({
        licenseValid: true,
        licenseServerUrl: 'https://license.acme.test',
        licenseKey: 'GOOD-KEY',
        licenseLastValidatedAt: Date.now() - 10 * DAY
      })
      fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: 'invalid' }))

      const r = await heartbeat()

      expect(r).toEqual({ ok: false, error: 'invalid' })
      expect(testSettings.licenseValid).toBe(false)
    })
  })

  describe('MQA-282 — verifyLease (client-side wrapper around license-lease-verify.ts)', () => {
    it('verifies a genuinely-signed lease against the bundled dev public key', () => {
      const token = signTestLease()
      expect(verifyLease(token)?.licenseKey).toBe('ATK-TEST1234')
    })

    it('rejects a tampered lease and never throws', () => {
      const token = signTestLease()
      const tampered = token.slice(0, -4) + 'XXXX'
      expect(verifyLease(tampered)).toBeNull()
    })

    it('rejects empty/missing input', () => {
      expect(verifyLease('')).toBeNull()
      expect(verifyLease(null)).toBeNull()
      expect(verifyLease(undefined)).toBeNull()
    })
  })

  describe('MQA-282 — checkLicenseGrace prefers a valid signed lease over the wall-clock grace', () => {
    it('allows via the lease even when licenseValid is false and no trial has started', () => {
      testSettings = baseSettings({
        licenseGateEnabled: true,
        licenseValid: false,
        licenseKey: LEASE_KEY,
        licenseLease: signTestLease({ notAfter: Date.now() + 5 * DAY })
      })

      const r = checkLicenseGrace()

      expect(r.allowed).toBe(true)
      expect(r.leaseExpiresAt).toBeGreaterThan(Date.now())
      expect(fetchMock).not.toHaveBeenCalled() // lease check is fully offline
    })

    it('a lease minted for another machine, or for another key, is not this device to use', () => {
      testSettings = baseSettings({
        licenseGateEnabled: true,
        licenseValid: false,
        licenseKey: LEASE_KEY,
        licenseLease: signTestLease({ machineId: 'someone-elses-laptop', notAfter: Date.now() + 5 * DAY })
      })
      expect(checkLicenseGrace()).toEqual({ allowed: false, reason: 'not_activated' })
      expect(licenseDisplayStatus().leaseExpiresAt).toBeNull()

      testSettings = baseSettings({
        licenseGateEnabled: true,
        licenseValid: false,
        licenseKey: 'ATK-OTHERKEY',
        licenseLease: signTestLease({ notAfter: Date.now() + 5 * DAY })
      })
      expect(checkLicenseGrace()).toEqual({ allowed: false, reason: 'not_activated' })
    })

    it('a clock rolled back behind the last server contact or the lease issue time cannot revive a lease', () => {
      const future = Date.now() + 3 * DAY
      testSettings = baseSettings({
        licenseGateEnabled: true,
        licenseValid: true,
        licenseKey: LEASE_KEY,
        licenseLastValidatedAt: future, // stamped in the future: the clock went backwards
        licenseLease: signTestLease({ notAfter: Date.now() + 5 * DAY })
      })
      // Falls through to the wall-clock branch, whose own rollback guard blocks and re-checks.
      expect(checkLicenseGrace()).toEqual({ allowed: false, reason: 'expired_grace' })

      testSettings = baseSettings({
        licenseGateEnabled: true,
        licenseValid: false,
        licenseKey: LEASE_KEY,
        licenseLease: signTestLease({ issuedAt: future, notAfter: future + 14 * DAY })
      })
      expect(checkLicenseGrace()).toEqual({ allowed: false, reason: 'not_activated' })
    })

    it('allows via the lease even when the wall-clock grace/hard-cap would otherwise have expired', () => {
      // The exact scenario the lease exists for: a license that phoned home once, long enough ago
      // that the 30-day wall-clock hard cap has passed, but whose signed lease is still inside its
      // own (separately tracked) validity window.
      testSettings = baseSettings({
        licenseGateEnabled: true,
        licenseValid: true,
        licenseKey: LEASE_KEY,
        licenseLastValidatedAt: Date.now() - 45 * DAY, // past HARD_CAP_MS
        licenseLease: signTestLease({ notAfter: Date.now() + 2 * DAY })
      })

      const r = checkLicenseGrace()

      expect(r).toEqual({ allowed: true, leaseExpiresAt: expect.any(Number) })
      expect(fetchMock).not.toHaveBeenCalled() // never falls through to the heartbeat-triggering branch
    })

    it('an EXPIRED lease is not preferred — falls through to the wall-clock logic below it', () => {
      testSettings = baseSettings({
        licenseGateEnabled: true,
        licenseValid: true,
        licenseKey: LEASE_KEY,
        licenseLastValidatedAt: Date.now() - 1 * DAY, // inside soft grace
        licenseLease: signTestLease({ notAfter: Date.now() - 1000 }) // already expired
      })

      const r = checkLicenseGrace()

      // Falls through to the (still-valid) wall-clock soft grace, not blocked outright.
      expect(r).toEqual({ allowed: true })
    })

    it('a TAMPERED lease is not preferred — falls through exactly as if there were no lease at all', () => {
      const good = signTestLease({ notAfter: Date.now() + 5 * DAY })
      testSettings = baseSettings({
        licenseGateEnabled: true,
        licenseValid: false,
        licenseLease: good.slice(0, -4) + 'XXXX'
      })

      const r = checkLicenseGrace()

      expect(r).toEqual({ allowed: false, reason: 'not_activated' })
    })
  })

  describe('MQA-281 — checkLicenseGrace: local trial fallback for a never-activated device', () => {
    it('allows during an active trial, reporting daysRemaining', () => {
      testSettings = baseSettings({
        licenseGateEnabled: true,
        licenseValid: false,
        trialStartedAt: Date.now() - 3 * DAY
      })

      const r = checkLicenseGrace()

      expect(r.allowed).toBe(true)
      expect(r.trialActive).toBe(true)
      expect(r.trialDaysRemaining).toBe(TRIAL_DAYS - 3)
    })

    it('blocks with reason trial_expired once the trial window has fully elapsed', () => {
      testSettings = baseSettings({
        licenseGateEnabled: true,
        licenseValid: false,
        trialStartedAt: Date.now() - (TRIAL_DAYS + 1) * DAY
      })

      const r = checkLicenseGrace()

      expect(r).toEqual({ allowed: false, reason: 'trial_expired', trialDaysRemaining: 0 })
    })

    it('a real activation (licenseValid true) is never overridden by a stale trial timestamp', () => {
      testSettings = baseSettings({
        licenseGateEnabled: true,
        licenseValid: true,
        licenseLastValidatedAt: Date.now() - 1 * DAY,
        trialStartedAt: Date.now() - (TRIAL_DAYS + 1) * DAY // would read as expired if consulted
      })

      const r = checkLicenseGrace()

      // Wall-clock soft-grace path wins; the expired trial is never even consulted.
      expect(r).toEqual({ allowed: true })
    })
  })

  describe('MQA-281 — noteQualifyingUse: trial starts on FIRST qualifying use, never on install', () => {
    it('starts the trial on a qualifying suggest result', () => {
      testSettings = baseSettings({ trialStartedAt: null })

      noteQualifyingUse('suggest', 'What should I say next?', 'transcript tail')

      expect(testSettings.trialStartedAt).toBeGreaterThan(0)
      expect(setSettingsSpy).toHaveBeenCalledWith({ trialStartedAt: expect.any(Number) })
    })

    it('starts the trial on a qualifying summary/recap result', () => {
      testSettings = baseSettings({ trialStartedAt: null })
      noteQualifyingUse('summary')
      expect(testSettings.trialStartedAt).toBeGreaterThan(0)
    })

    it('does NOT start the trial for a plain answer/vision ask', () => {
      testSettings = baseSettings({ trialStartedAt: null })

      noteQualifyingUse('answer', 'a typed question')
      noteQualifyingUse('vision', 'describe my screen')

      expect(testSettings.trialStartedAt).toBeNull()
      expect(setSettingsSpy).not.toHaveBeenCalled()
    })

    it('is a no-op once a trial has already started — never restarts or extends it', () => {
      const startedAt = Date.now() - 5 * DAY
      testSettings = baseSettings({ trialStartedAt: startedAt })

      noteQualifyingUse('suggest')
      noteQualifyingUse('summary')

      expect(testSettings.trialStartedAt).toBe(startedAt)
      expect(setSettingsSpy).not.toHaveBeenCalled()
    })

    it('MQA-278 belt-and-suspenders: a demo-tagged payload never starts a trial, even on a qualifying mode', () => {
      // Act 2's onboarding demo cannot reach this call in practice (it never touches window.toto — see
      // onboarding-demo.ts's own IPC-free contract test), but this proves the defensive check works
      // directly: a demo-tagged prompt/transcript must refuse exactly like refuseIfDemoTagged does for
      // saveMeeting/saveNote/enqueueIngest, so a future wiring mistake can't leak a demo "result" into
      // a real trial start.
      testSettings = baseSettings({ trialStartedAt: null })

      noteQualifyingUse('suggest', tagAsDemo('a scripted demo prompt'), 'transcript tail')

      expect(testSettings.trialStartedAt).toBeNull()
      expect(setSettingsSpy).not.toHaveBeenCalled()
    })

    it('MQA-278: a demo tag anywhere in the tagged fields refuses, even mixed with a real-looking field', () => {
      testSettings = baseSettings({ trialStartedAt: null })

      noteQualifyingUse('summary', 'a real-looking prompt', tagAsDemo('but this transcript is fake'))

      expect(testSettings.trialStartedAt).toBeNull()
    })

    it('never touches settings at all when nothing qualifies — not even a read-then-noop write', () => {
      testSettings = baseSettings({ trialStartedAt: null })
      noteQualifyingUse('answer')
      expect(setSettingsSpy).not.toHaveBeenCalled()
    })
  })

  describe('licenseDisplayStatus — live-verified status for Settings/LicenseGate copy', () => {
    it('reports leaseExpiresAt from a valid lease, independent of licenseGateEnabled', () => {
      testSettings = baseSettings({
        licenseGateEnabled: false, // OFF — display status still works; it is not an enforcement check
        licenseKey: LEASE_KEY,
        licenseLease: signTestLease({ notAfter: Date.now() + 3 * DAY })
      })

      const status = licenseDisplayStatus()

      expect(status.leaseExpiresAt).toBeGreaterThan(Date.now())
    })

    it('reports trialActive + daysRemaining for a never-activated device mid-trial', () => {
      testSettings = baseSettings({ licenseValid: false, trialStartedAt: Date.now() - 2 * DAY })

      const status = licenseDisplayStatus()

      expect(status.trialActive).toBe(true)
      expect(status.trialDaysRemaining).toBe(TRIAL_DAYS - 2)
    })

    it('never reports an active trial once a real activation exists, even with a stale trial timestamp', () => {
      testSettings = baseSettings({ licenseValid: true, trialStartedAt: Date.now() - 2 * DAY })

      const status = licenseDisplayStatus()

      expect(status.trialActive).toBe(false)
      expect(status.trialDaysRemaining).toBe(0)
    })

    it('is all-null/false/0 for a fresh, never-touched install', () => {
      testSettings = baseSettings()
      expect(licenseDisplayStatus()).toEqual({ leaseExpiresAt: null, trialActive: false, trialDaysRemaining: 0 })
    })
  })

  describe('fetchLicenseConfig — informational GET /license/config read (ActLicense onboarding scene)', () => {
    it('returns the server-declared pair on success', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ ok: true, licenseEnforcement: false, licenseUiEnabled: false, drift: false })
      )

      const r = await fetchLicenseConfig('https://license.acme.test')

      expect(r).toEqual({ ok: true, licenseEnforcement: false, licenseUiEnabled: false, drift: false })
      expect(fetchMock).toHaveBeenCalledWith('https://license.acme.test/license/config', expect.anything())
    })

    it('normalizes a scheme-less URL before fetching, same convention as activate/heartbeat', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ ok: true, licenseEnforcement: true, licenseUiEnabled: true, drift: false })
      )

      await fetchLicenseConfig('license.acme.test')

      expect(fetchMock).toHaveBeenCalledWith('https://license.acme.test/license/config', expect.anything())
    })

    it('a network failure or malformed response reads as error:"network", never throws', async () => {
      fetchMock.mockRejectedValue(new Error('offline'))
      expect(await fetchLicenseConfig('https://license.acme.test')).toEqual({ ok: false, error: 'network' })

      fetchMock.mockResolvedValue(jsonResponse({ unexpected: 'shape' }))
      expect(await fetchLicenseConfig('https://license.acme.test')).toEqual({ ok: false, error: 'network' })
    })
  })
})
