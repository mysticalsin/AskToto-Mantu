import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app, safeStorage } from 'electron'
import { DEFAULT_SETTINGS } from '@shared/ipc'
import { getSettings, setSettings, getApiKey, setApiKey, listDustAgents, testApiKey } from './store'
import { decryptSecret } from './secrets'

vi.mock('electron')

// Mimics the real @dust-tt/client 1.2.6 shape: getAgentConfigurations returns a Result
// (isErr()/isOk()) whose .value is a direct ARRAY of agent objects — no wrapping envelope.
// DustAPI must be a real class (not vi.fn().mockImplementation(arrowFn)) — store.ts calls
// `new DustAPI(...)`, and arrow functions cannot be used as constructors.
const getAgentConfigurations = vi.fn()
vi.mock('@dust-tt/client', () => {
  class DustAPI {
    getAgentConfigurations(...args: unknown[]): unknown {
      return getAgentConfigurations(...args)
    }
  }
  return { DustAPI }
})

// Mirror store.ts at-rest encryption so tests can read what was persisted. Two markers exist: V1 =
// safeStorage (prod), V2 = AES-GCM file backend (dev / unpackaged — what these tests run under).
const ENC_V1 = Buffer.from('ATKENC1\n')
const ENC_V2 = Buffer.from('ATKENC2\n')
function readPersisted(path: string): Record<string, unknown> {
  const buf = readFileSync(path)
  if (buf.subarray(0, ENC_V2.length).equals(ENC_V2)) {
    return JSON.parse(decryptSecret(buf.subarray(ENC_V2.length)))
  }
  if (buf.subarray(0, ENC_V1.length).equals(ENC_V1)) {
    return JSON.parse(safeStorage.decryptString(buf.subarray(ENC_V1.length)))
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
    getAgentConfigurations.mockReset()
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

    // Locked keys keep their previous / managed values. providerModels has no managed override here, so
    // it falls back to its DEFAULT_SETTINGS value — the hard-locked base Dust agent (DUST_BASE_AGENT_ID),
    // not an empty map.
    expect(result.temperature).toBe(0.2)
    expect(result.providerModels).toEqual({ dust: 'vJxYHvTRBT' })
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
    // An encryption marker (V1 safeStorage or V2 AES) is present and the secret text is NOT plaintext.
    const encrypted =
      bytes.subarray(0, ENC_V1.length).equals(ENC_V1) || bytes.subarray(0, ENC_V2.length).equals(ENC_V2)
    expect(encrypted).toBe(true)
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

  it('migrates a legacy plaintext API key to encrypted-at-rest on first read', () => {
    // A pre-existing `plain:`-prefixed key file (from an older build) must (a) still return the key
    // and (b) be re-encrypted on disk so it never lingers as plaintext. Idempotent thereafter.
    // Use a real base64 round-trip (like the context-docs test) so "not plaintext" is meaningful.
    vi.spyOn(safeStorage, 'encryptString').mockImplementation((v: string) =>
      Buffer.from('B64:' + Buffer.from(v, 'utf8').toString('base64'))
    )
    vi.spyOn(safeStorage, 'decryptString').mockImplementation((b: Buffer) => {
      const s = b.toString('utf8')
      return s.startsWith('B64:') ? Buffer.from(s.slice(4), 'base64').toString('utf8') : s
    })
    const prev = process.env.MINIMAX_API_KEY
    delete process.env.MINIMAX_API_KEY
    try {
      const keyFile = join(userData, 'key-minimax.bin')
      writeFileSync(keyFile, Buffer.from('plain:sk-legacy-0001'))

      // First read returns the plaintext...
      expect(getApiKey('minimax')).toBe('sk-legacy-0001')
      // ...and the file on disk is no longer the legacy plaintext marker, nor readable plaintext.
      const after = readFileSync(keyFile)
      expect(after.subarray(0, 6).toString('utf8')).not.toBe('plain:')
      expect(after.toString('utf8')).not.toContain('sk-legacy-0001')
      // Subsequent reads still return the same key (now via the decrypt path) — idempotent.
      expect(getApiKey('minimax')).toBe('sk-legacy-0001')
    } finally {
      if (prev === undefined) delete process.env.MINIMAX_API_KEY
      else process.env.MINIMAX_API_KEY = prev
    }
  })

  it('encryptTranscripts defaults to true for an existing install that never touched the toggle', () => {
    // settings.json is a SPARSE overlay of only explicitly-changed keys (see readUserRaw's docstring) —
    // it is never pre-populated with a full snapshot of defaults. So an existing install that never
    // touched this toggle has no `encryptTranscripts` key on disk at all, and correctly inherits
    // whatever DEFAULT_SETTINGS says today — no migration needed. This test is the receipt for that
    // claim: it simulates a pre-existing settings.json (written before this field existed) and confirms
    // the new safer default (true) applies automatically.
    writeFileSync(join(userData, 'settings.json'), JSON.stringify({ provider: 'openai' }), 'utf8')
    expect(getSettings().encryptTranscripts).toBe(true)
  })

  it('respects an explicit prior opt-out of transcript encryption', () => {
    // A user who deliberately disabled encryption keeps that choice — flipping the DEFAULT must never
    // silently override an explicit user decision already persisted to disk.
    writeFileSync(join(userData, 'settings.json'), JSON.stringify({ encryptTranscripts: false }), 'utf8')
    expect(getSettings().encryptTranscripts).toBe(false)
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

  describe('listDustAgents', () => {
    beforeEach(() => {
      setSettings({ dustWorkspaceId: 'ws-1' })
      setApiKey('dust', 'test-dust-key')
    })

    it('requests view:list and returns only active (and status-undefined) agents, mapped to picker shape', async () => {
      getAgentConfigurations.mockResolvedValue({
        isErr: () => false,
        value: [
          {
            sId: 'agent-active',
            name: 'Active Agent',
            description: 'An active agent',
            status: 'active',
            scope: 'workspace',
            model: { providerId: 'anthropic', modelId: 'claude-sonnet' }
          },
          {
            sId: 'agent-archived',
            name: 'Archived Agent',
            description: 'Should be filtered out',
            status: 'archived',
            scope: 'workspace',
            model: { providerId: 'anthropic', modelId: 'claude-sonnet' }
          },
          {
            sId: 'agent-draft',
            name: 'Draft Agent',
            description: 'Should be filtered out',
            status: 'draft',
            scope: 'workspace',
            model: { providerId: 'openai', modelId: 'gpt-4o' }
          },
          {
            sId: 'agent-no-status',
            name: 'No Status Agent',
            description: 'Undefined status is treated as active',
            scope: 'workspace',
            model: { providerId: 'openai', modelId: 'gpt-4o-mini' }
          }
        ]
      })

      const result = await listDustAgents()

      // (a) the regression fix: view:'list' must be passed, or Dust's endpoint silently
      // restricts/empties the result set.
      expect(getAgentConfigurations).toHaveBeenCalledWith({ view: 'list' })

      // (b) only 'active' and status-undefined agents survive the filter.
      expect(result.ok).toBe(true)
      expect(result.agents?.map((a) => a.sId).sort()).toEqual(['agent-active', 'agent-no-status'])

      // (c) mapping produces the {sId, name, description, modelProviderId, modelId} picker shape.
      const active = result.agents?.find((a) => a.sId === 'agent-active')
      expect(active).toEqual({
        sId: 'agent-active',
        name: 'Active Agent',
        description: 'An active agent',
        modelProviderId: 'anthropic',
        modelId: 'claude-sonnet'
      })
    })
  })

  describe('testApiKey org allowlist', () => {
    it('refuses a provider blocked by managed-config allowedProviders, without making a network call', async () => {
      const managed = join(userData, 'managed-config.json')
      writeFileSync(managed, JSON.stringify({ allowedProviders: ['anthropic'] }), 'utf8')

      // 'openai' is deliberately excluded from the allowlist above. If the gate didn't short-circuit,
      // this would attempt a real OpenAI network call and fail/hang in the sandboxed test environment —
      // asserting the specific org-policy message (matching attempt()'s wording in index.ts) proves the
      // allowlist gate fired first, not a network failure.
      const result = await testApiKey('openai', 'sk-test-0001')

      expect(result.ok).toBe(false)
      expect(result.error).toBe("GPT · OpenAI is not on your organization's approved provider list.")
    })

    it('still tests an allowed provider normally (allowlist gate does not block permitted providers)', async () => {
      const managed = join(userData, 'managed-config.json')
      writeFileSync(managed, JSON.stringify({ allowedProviders: ['dust'] }), 'utf8')
      setSettings({ dustWorkspaceId: 'ws-1' })
      getAgentConfigurations.mockResolvedValue({ isErr: () => false, value: [] })

      const result = await testApiKey('dust', 'test-dust-key')

      expect(result.ok).toBe(true)
    })

    it('does not gate providers when no allowedProviders policy is set (null = unrestricted)', async () => {
      setSettings({ dustWorkspaceId: 'ws-1' })
      getAgentConfigurations.mockResolvedValue({ isErr: () => false, value: [] })

      const result = await testApiKey('dust', 'test-dust-key')

      expect(result.ok).toBe(true)
    })
  })
})
