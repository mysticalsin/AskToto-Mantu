import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app, safeStorage } from 'electron'
import { DEFAULT_SETTINGS } from '@shared/ipc'
import { getSettings, setSettings } from './store'

vi.mock('electron')

// Mirror store.ts at-rest encryption (marker + safeStorage) so tests can read what was persisted.
const ENC_MARKER = Buffer.from('ATKENC1\n')
function readPersisted(path: string): Record<string, unknown> {
  const buf = readFileSync(path)
  if (buf.subarray(0, ENC_MARKER.length).equals(ENC_MARKER)) {
    return JSON.parse(safeStorage.decryptString(buf.subarray(ENC_MARKER.length)))
  }
  return JSON.parse(buf.toString('utf8'))
}

const mockAppGetPath = app.getPath as ReturnType<typeof vi.fn>

describe('store', () => {
  let userData: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'asktoto-store-test-'))
    mockAppGetPath.mockImplementation((name: string) => {
      if (name === 'userData') return userData
      return join(userData, name)
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('layers defaults, managed config, and user overrides', () => {
    // Managed defaults live in userData/managed-config.json for this test.
    const managed = join(userData, 'managed-config.json')
    writeFileSync(
      managed,
      JSON.stringify({ temperature: 0.1, suggestEverySec: 30, _ignored: 'secret' }),
      'utf8'
    )

    const settingsPath = join(userData, 'settings.json')
    writeFileSync(
      settingsPath,
      JSON.stringify({ provider: 'openai', temperature: 0.9 }),
      'utf8'
    )

    const s = getSettings()
    expect(s.provider).toBe('openai')       // user wins
    expect(s.temperature).toBe(0.9)          // user wins over managed
    expect(s.suggestEverySec).toBe(30)       // managed wins over default
    expect(s.contentProtection).toBe(true)   // untouched default
  })

  it('drops locked keys when setSettings is called', () => {
    const managed = join(userData, 'managed-config.json')
    writeFileSync(
      managed,
      JSON.stringify({ temperature: 0.2, locked: ['temperature', 'providerModels'] }),
      'utf8'
    )

    const result = setSettings({ temperature: 0.99, provider: 'openai', autoSuggest: false })

    // Locked keys keep their previous / managed values.
    expect(result.temperature).toBe(0.2)
    expect(result.providerModels).toEqual({})
    // Unlocked keys are persisted.
    expect(result.provider).toBe('openai')
    expect(result.autoSuggest).toBe(false)

    // Ensure the persisted user file does not contain locked keys.
    const raw = readPersisted(join(userData, 'settings.json'))
    expect(raw.temperature).toBeUndefined()
    expect(raw.providerModels).toBeUndefined()
    expect(raw.provider).toBe('openai')
    expect(raw.autoSuggest).toBe(false)
  })

  it('encrypts sensitive user data at rest (context docs + profile not plaintext)', () => {
    // The default electron mock "encrypt" only prefixes a tag (plaintext stays visible). Use a real
    // base64 round-trip here so "not plaintext" is a meaningful assertion.
    vi.spyOn(safeStorage, 'encryptString').mockImplementation((v: string) =>
      Buffer.from('B64:' + Buffer.from(v, 'utf8').toString('base64'))
    )
    vi.spyOn(safeStorage, 'decryptString').mockImplementation((b: Buffer) => {
      const s = b.toString('utf8')
      return s.startsWith('B64:') ? Buffer.from(s.slice(4), 'base64').toString('utf8') : s
    })
    setSettings({
      contextDocs: { general: [{ name: 'resume.txt', text: 'SECRET-RESUME-CONTENT-12345' }] },
      profile: { name: 'Tony', role: '', company: '', resume: 'CONFIDENTIAL-RESUME', jobDescription: '', notes: '' }
    })
    const bytes = readFileSync(join(userData, 'settings.json'))
    // Marker present and the secret text is NOT readable as plaintext in the file.
    expect(bytes.subarray(0, ENC_MARKER.length).equals(ENC_MARKER)).toBe(true)
    expect(bytes.toString('utf8')).not.toContain('SECRET-RESUME-CONTENT-12345')
    expect(bytes.toString('utf8')).not.toContain('CONFIDENTIAL-RESUME')
    // But it round-trips through getSettings.
    const s = getSettings()
    expect(s.contextDocs.general[0].text).toBe('SECRET-RESUME-CONTENT-12345')
    expect(s.profile.resume).toBe('CONFIDENTIAL-RESUME')
  })

  it('still reads legacy plaintext settings.json (migration path)', () => {
    writeFileSync(join(userData, 'settings.json'), JSON.stringify({ provider: 'openai', temperature: 0.7 }), 'utf8')
    expect(getSettings().provider).toBe('openai')
    expect(getSettings().temperature).toBe(0.7)
  })

  it('ignores malformed keys in user overrides', () => {
    const settingsPath = join(userData, 'settings.json')
    writeFileSync(
      settingsPath,
      JSON.stringify({ temperature: 'hot', provider: 'anthropic', suggestEverySec: 10 }),
      'utf8'
    )

    const s = getSettings()
    // Malformed temperature is dropped; valid keys are kept.
    expect(s.temperature).toBe(DEFAULT_SETTINGS.temperature)
    expect(s.provider).toBe('anthropic')
    expect(s.suggestEverySec).toBe(10)
  })
})
