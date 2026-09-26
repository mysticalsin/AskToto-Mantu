import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encryptProxyKey } from '../../scripts/lib/embedded-cloudflare-crypto.mjs'

vi.mock('electron')
vi.mock('./store', () => ({ getApiKey: vi.fn(), setApiKey: vi.fn(), setSettings: vi.fn(), getSettings: vi.fn() }))
vi.mock('./cahe-edition', () => ({ isCaheEdition: vi.fn() }))
vi.mock('./logger', () => ({ mainLog: { warn: vi.fn(), info: vi.fn() }, auditLog: vi.fn() }))

import { app } from 'electron'
import { getApiKey, setApiKey, setSettings } from './store'
import { isCaheEdition } from './cahe-edition'
import { mainLog, auditLog } from './logger'
import { importEmbeddedCaheKey } from './cahe-embedded-key'

// cahe-embedded-key.ts keeps its marker filename private (seededMarkerPath()) — there is no exported
// constant, so the observable side effect (a file dropped in userData) is asserted here by name.
const MARKER_NAME = '.cahe-key-seeded'
// 24 chars after the `sk-kimi-` prefix — comfortably over KIMI_KEY_PATTERN's { 16, } minimum.
const VALID_TOKEN = 'sk-kimi-test0123456789abcdefghij'

describe('Cahê embedded Kimi key seed', () => {
  let userData: string
  let resourcesPath: string
  let originalResourcesPath: PropertyDescriptor | undefined

  const markerPath = (): string => join(userData, MARKER_NAME)
  const bundlePath = (): string => join(resourcesPath, 'cahe', 'kimi.json')
  const writeEncryptedBundle = (token: string = VALID_TOKEN): void => {
    mkdirSync(join(resourcesPath, 'cahe'), { recursive: true })
    writeFileSync(bundlePath(), JSON.stringify(encryptProxyKey(token)))
  }
  const writePlainBundle = (contents: string): void => {
    mkdirSync(join(resourcesPath, 'cahe'), { recursive: true })
    writeFileSync(bundlePath(), contents)
  }

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'asktoto-cahe-embedded-key-userdata-'))
    resourcesPath = mkdtempSync(join(tmpdir(), 'asktoto-cahe-embedded-key-resources-'))
    originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: resourcesPath })

    ;(app.getPath as ReturnType<typeof vi.fn>).mockReset().mockImplementation((name: string) =>
      name === 'userData' ? userData : join(userData, name)
    )
    ;(isCaheEdition as ReturnType<typeof vi.fn>).mockReset().mockReturnValue(true)
    ;(getApiKey as ReturnType<typeof vi.fn>).mockReset().mockReturnValue('')
    ;(setApiKey as ReturnType<typeof vi.fn>).mockReset()
    ;(setSettings as ReturnType<typeof vi.fn>).mockReset()
    ;(mainLog.warn as ReturnType<typeof vi.fn>).mockReset()
    ;(mainLog.info as ReturnType<typeof vi.fn>).mockReset()
    ;(auditLog as ReturnType<typeof vi.fn>).mockReset()
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
    rmSync(resourcesPath, { recursive: true, force: true })
    if (originalResourcesPath) Object.defineProperty(process, 'resourcesPath', originalResourcesPath)
    else delete (process as unknown as { resourcesPath?: string }).resourcesPath
  })

  it('is a no-op outside the Cahê edition — no marker, no keystore lookup, no provider seed', () => {
    ;(isCaheEdition as ReturnType<typeof vi.fn>).mockReturnValue(false)
    writeEncryptedBundle()

    importEmbeddedCaheKey()

    expect(app.getPath).not.toHaveBeenCalled()
    expect(getApiKey).not.toHaveBeenCalled()
    expect(setApiKey).not.toHaveBeenCalled()
    expect(setSettings).not.toHaveBeenCalled()
    expect(existsSync(markerPath())).toBe(false)
  })

  it('decrypts the encrypted blob, seeds the sk-kimi- token, activates kimi, and writes the marker', () => {
    writeEncryptedBundle(VALID_TOKEN)

    importEmbeddedCaheKey()

    expect(setApiKey).toHaveBeenCalledTimes(1)
    expect(setApiKey).toHaveBeenCalledWith('kimi', VALID_TOKEN)
    expect(auditLog).toHaveBeenCalledWith('key.set', { provider: 'kimi', source: 'cahe-embedded' })
    expect(setSettings).toHaveBeenCalledTimes(1)
    expect(setSettings).toHaveBeenCalledWith({ provider: 'kimi' })
    expect(existsSync(markerPath())).toBe(true)
  })

  it('fail-closed: refuses a plaintext kimiApiKey bundle (must never ship) — no key, no marker', () => {
    writePlainBundle(JSON.stringify({ kimiApiKey: VALID_TOKEN }))

    expect(() => importEmbeddedCaheKey()).not.toThrow()

    expect(setApiKey).not.toHaveBeenCalled()
    expect(setSettings).not.toHaveBeenCalled()
    const warnCalls = (mainLog.warn as ReturnType<typeof vi.fn>).mock.calls
    expect(warnCalls.some((c) => String(c[0]).includes('plaintext kimiApiKey'))).toBe(true)
    expect(existsSync(markerPath())).toBe(false)
  })

  it('fail-closed: tampered ciphertext does not seed and does not burn the marker', () => {
    const blob = encryptProxyKey(VALID_TOKEN) as { ciphertext: string; [k: string]: unknown }
    blob.ciphertext = Buffer.from('tampered-not-valid-gcm').toString('base64')
    writePlainBundle(JSON.stringify(blob))

    expect(() => importEmbeddedCaheKey()).not.toThrow()

    expect(setApiKey).not.toHaveBeenCalled()
    expect(setSettings).not.toHaveBeenCalled()
    expect(existsSync(markerPath())).toBe(false)
  })

  it('never re-seeds once the marker exists — neither the key nor the provider default', () => {
    writeFileSync(markerPath(), '2026-01-01T00:00:00.000Z')
    writeEncryptedBundle()
    ;(getApiKey as ReturnType<typeof vi.fn>).mockReturnValue('')

    importEmbeddedCaheKey()

    expect(getApiKey).not.toHaveBeenCalled()
    expect(setApiKey).not.toHaveBeenCalled()
    expect(setSettings).not.toHaveBeenCalled()
    expect(readFileSync(markerPath(), 'utf8')).toBe('2026-01-01T00:00:00.000Z')
  })

  it('does not overwrite an existing key, but still activates kimi as the default provider and writes the marker', () => {
    ;(getApiKey as ReturnType<typeof vi.fn>).mockReturnValue('user-provided-key-value')
    writeEncryptedBundle()

    importEmbeddedCaheKey()

    expect(getApiKey).toHaveBeenCalledWith('kimi')
    expect(setApiKey).not.toHaveBeenCalled()
    expect(setSettings).toHaveBeenCalledWith({ provider: 'kimi' })
    expect(existsSync(markerPath())).toBe(true)
  })

  it('missing bundle: leaves normal onboarding in place — no keyless kimi default, and NO marker', () => {
    expect(existsSync(bundlePath())).toBe(false)

    expect(() => importEmbeddedCaheKey()).not.toThrow()

    expect(setApiKey).not.toHaveBeenCalled()
    expect(setSettings).not.toHaveBeenCalled()
    expect(mainLog.warn).toHaveBeenCalled()
    expect(existsSync(markerPath())).toBe(false)
  })

  it('malformed-JSON bundle: leaves normal onboarding in place — no keyless kimi default, and no marker', () => {
    writePlainBundle('{ this is not valid JSON')

    expect(() => importEmbeddedCaheKey()).not.toThrow()

    expect(setApiKey).not.toHaveBeenCalled()
    expect(setSettings).not.toHaveBeenCalled()
    expect(mainLog.warn).toHaveBeenCalledWith('[cahe-embedded-key] embedded key import failed', expect.anything())
    expect(existsSync(markerPath())).toBe(false)
  })

  it('encrypted blob whose plaintext is not an sk-kimi- token: no seed, no marker', () => {
    writeEncryptedBundle('REPLACE_ME_not_a_kimi_key_xxxxxx')

    expect(() => importEmbeddedCaheKey()).not.toThrow()

    expect(setApiKey).not.toHaveBeenCalled()
    expect(setSettings).not.toHaveBeenCalled()
    expect(existsSync(markerPath())).toBe(false)
  })

  it('does not throw and still writes the marker when setSettings itself fails', () => {
    writeEncryptedBundle()
    ;(setSettings as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('disk full')
    })

    expect(() => importEmbeddedCaheKey()).not.toThrow()

    expect(setApiKey).toHaveBeenCalledWith('kimi', VALID_TOKEN)
    expect(mainLog.warn).toHaveBeenCalledWith('[cahe-embedded-key] could not seed the default Kimi provider', expect.anything())
    expect(existsSync(markerPath())).toBe(true)
  })
})
