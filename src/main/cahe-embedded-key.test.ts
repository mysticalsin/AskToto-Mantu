import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron')
vi.mock('./store', () => ({ getApiKey: vi.fn(), setApiKey: vi.fn(), setSettings: vi.fn() }))
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
  const writeBundle = (contents: string): void => {
    mkdirSync(join(resourcesPath, 'cahe'), { recursive: true })
    writeFileSync(bundlePath(), contents)
  }

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'asktoto-cahe-embedded-key-userdata-'))
    resourcesPath = mkdtempSync(join(tmpdir(), 'asktoto-cahe-embedded-key-resources-'))
    originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: resourcesPath })

    // vi.mock(path, factory)'s vi.fn() instances are created once, at module-mock setup, and are not
    // reached by vi.restoreAllMocks()/vi.clearAllMocks() the way per-test vi.fn()s are — so each mock is
    // explicitly reset here rather than relying on a global reset to clear the previous test's call log.
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
    else delete (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  })

  it('is a no-op outside the Cahê edition — no marker, no keystore lookup, no provider seed', () => {
    ;(isCaheEdition as ReturnType<typeof vi.fn>).mockReturnValue(false)
    writeBundle(JSON.stringify({ kimiApiKey: VALID_TOKEN }))

    importEmbeddedCaheKey()

    expect(app.getPath).not.toHaveBeenCalled()
    expect(getApiKey).not.toHaveBeenCalled()
    expect(setApiKey).not.toHaveBeenCalled()
    expect(setSettings).not.toHaveBeenCalled()
    expect(existsSync(markerPath())).toBe(false)
  })

  it('extracts the bare sk-kimi- token from a label-prefixed bundle, seeds it, activates kimi, and writes the marker', () => {
    // Tolerates an accidental "Metis: " label prefix the operator may have pasted alongside the key.
    writeBundle(JSON.stringify({ kimiApiKey: `Metis: ${VALID_TOKEN}` }))

    importEmbeddedCaheKey()

    expect(setApiKey).toHaveBeenCalledTimes(1)
    expect(setApiKey).toHaveBeenCalledWith('kimi', VALID_TOKEN)
    expect(auditLog).toHaveBeenCalledWith('key.set', { provider: 'kimi', source: 'cahe-embedded' })
    // caheEditionPolicy() no longer locks/forces `provider` — the out-of-box Kimi default now has to come
    // from this one-time setSettings write instead of a managed-default override.
    expect(setSettings).toHaveBeenCalledTimes(1)
    expect(setSettings).toHaveBeenCalledWith({ provider: 'kimi' })
    expect(existsSync(markerPath())).toBe(true)
  })

  it('never re-seeds once the marker exists — neither the key nor the provider default, so a user-chosen provider survives restarts', () => {
    writeFileSync(markerPath(), '2026-01-01T00:00:00.000Z')
    writeBundle(JSON.stringify({ kimiApiKey: VALID_TOKEN })) // present, but must never be consulted
    ;(getApiKey as ReturnType<typeof vi.fn>).mockReturnValue('') // the user cleared their key in Settings

    importEmbeddedCaheKey()

    expect(getApiKey).not.toHaveBeenCalled()
    expect(setApiKey).not.toHaveBeenCalled()
    // The marker guarantees this seed never re-fires, so a provider the user switched to later (Claude
    // CLI, Codex CLI, Dust, another API key, …) is never reset back to Kimi on a later launch.
    expect(setSettings).not.toHaveBeenCalled()
    // The early return happens before the marker is ever rewritten, so the original stamp survives.
    expect(readFileSync(markerPath(), 'utf8')).toBe('2026-01-01T00:00:00.000Z')
  })

  it('does not overwrite an existing key, but still activates kimi as the default provider and writes the marker', () => {
    ;(getApiKey as ReturnType<typeof vi.fn>).mockReturnValue('user-provided-key-value')
    writeBundle(JSON.stringify({ kimiApiKey: VALID_TOKEN }))

    importEmbeddedCaheKey()

    expect(getApiKey).toHaveBeenCalledWith('kimi')
    expect(setApiKey).not.toHaveBeenCalled()
    expect(setSettings).toHaveBeenCalledWith({ provider: 'kimi' })
    expect(existsSync(markerPath())).toBe(true)
  })

  it('missing bundle: leaves normal onboarding in place — no keyless kimi default, and NO marker so a corrected build can still seed later', () => {
    expect(existsSync(bundlePath())).toBe(false)

    expect(() => importEmbeddedCaheKey()).not.toThrow()

    expect(setApiKey).not.toHaveBeenCalled()
    // A build that shipped no key must NOT strand the user on a keyless "kimi" provider…
    expect(setSettings).not.toHaveBeenCalled()
    expect(mainLog.warn).toHaveBeenCalled()
    // …and must NOT burn the one-time marker, so a later keyed build (or a bundle that appears on a
    // subsequent launch) still gets a chance to seed rather than being disabled forever by one bad launch.
    expect(existsSync(markerPath())).toBe(false)
  })

  it('malformed-JSON bundle: leaves normal onboarding in place — no keyless kimi default, and no marker', () => {
    writeBundle('{ this is not valid JSON')

    expect(() => importEmbeddedCaheKey()).not.toThrow()

    expect(setApiKey).not.toHaveBeenCalled()
    expect(setSettings).not.toHaveBeenCalled()
    expect(mainLog.warn).toHaveBeenCalledWith('[cahe-embedded-key] embedded key import failed', expect.anything())
    expect(existsSync(markerPath())).toBe(false)
  })

  it('placeholder / wrong-format key (no sk-kimi- token): leaves normal onboarding in place — no keyless kimi default, and no marker', () => {
    // The real-world failure: an installer built from a placeholder key file. Extraction finds nothing, so
    // the app must fall through to normal onboarding, not sit on Kimi with no working key.
    writeBundle(JSON.stringify({ kimiApiKey: 'REPLACE_ME' }))

    expect(() => importEmbeddedCaheKey()).not.toThrow()

    expect(setApiKey).not.toHaveBeenCalled()
    expect(setSettings).not.toHaveBeenCalled()
    expect(existsSync(markerPath())).toBe(false)
  })

  it('does not throw and still writes the marker when setSettings itself fails', () => {
    writeBundle(JSON.stringify({ kimiApiKey: VALID_TOKEN }))
    ;(setSettings as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('disk full')
    })

    expect(() => importEmbeddedCaheKey()).not.toThrow()

    expect(setApiKey).toHaveBeenCalledWith('kimi', VALID_TOKEN)
    expect(mainLog.warn).toHaveBeenCalledWith('[cahe-embedded-key] could not seed the default Kimi provider', expect.anything())
    expect(existsSync(markerPath())).toBe(true)
  })
})
