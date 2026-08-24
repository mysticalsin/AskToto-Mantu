import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app, safeStorage } from 'electron'
import { DEFAULT_SETTINGS } from '@shared/ipc'
import {
  getSettings,
  setSettings,
  recordMeetingSummarized,
  getApiKey,
  setApiKey,
  listDustAgents,
  testApiKey,
  getAllowedProviders,
  getLockedKeys
} from './store'
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

// testApiKey's OpenAI-shaped path, so the catch block that renders the Test button's message can be
// driven with a real upstream failure. Class, not an arrow: store.ts calls `new OpenAI(...)`.
const chatCompletionsCreate = vi.fn()
vi.mock('openai', () => {
  class OpenAI {
    chat = { completions: { create: (...args: unknown[]): unknown => chatCompletionsCreate(...args) } }
  }
  return { default: OpenAI }
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
    // store.ts's getApiKey() short-circuits on the provider's env var BEFORE it ever touches the
    // profile on disk (`const env = process.env[ENV_VAR[provider]]; if (env) return env`). That is
    // intended product behaviour, but it makes these tests read the developer's ambient shell instead
    // of the isolated temp profile: a machine exporting a real KIMI_API_KEY / OPENAI_API_KEY / … fails
    // the key assertions AND makes Vitest print that live credential in the diff. Clear every provider
    // key var so this suite only ever observes what it wrote itself. Every name in store.ts's ENV_VAR
    // map ends in `_API_KEY` EXCEPT Cloudflare's METIS_PROXY_KEY (that credential is the operator's
    // Worker secret, not a provider API key, and is named for what it actually is) — so that one is
    // listed explicitly, exactly as this comment has always instructed. Any further provider whose env
    // var breaks the convention goes in the same list.
    const EXPLICIT_NON_API_KEY_VARS = new Set(['METIS_PROXY_KEY'])
    for (const name of Object.keys(process.env)) {
      if (name.endsWith('_API_KEY') || EXPLICIT_NON_API_KEY_VARS.has(name)) vi.stubEnv(name, undefined)
    }
    mockAppGetPath.mockImplementation((name: string) => {
      if (name === 'userData') return userData
      return join(userData, name)
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    getAgentConfigurations.mockReset()
    chatCompletionsCreate.mockReset()
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('recordMeetingSummarized bumps the durable time-saved counters once per meeting', () => {
    expect(getSettings().usageStats).toEqual({ meetingsSummarized: 0, conversationMinutes: 0, firstMeetingAt: 0 })

    recordMeetingSummarized(42)
    let u = getSettings().usageStats
    expect(u.meetingsSummarized).toBe(1)
    expect(u.conversationMinutes).toBe(42)
    expect(u.firstMeetingAt).toBeGreaterThan(0)
    const firstAt = u.firstMeetingAt

    recordMeetingSummarized(18)
    u = getSettings().usageStats
    expect(u.meetingsSummarized).toBe(2)
    expect(u.conversationMinutes).toBe(60)
    expect(u.firstMeetingAt).toBe(firstAt) // set once, never moved by a later meeting

    // A zero/garbage duration still counts the meeting but adds no minutes (never poisons the total).
    recordMeetingSummarized(NaN as unknown as number)
    u = getSettings().usageStats
    expect(u.meetingsSummarized).toBe(3)
    expect(u.conversationMinutes).toBe(60)
  })

  it('heals a persisted provider-retired model id on read, without needing a settings save (MQA-001)', () => {
    // A user who once picked 'deepseek-chat' has it in providerModels forever — and that override beats
    // every registry default in resolveModelTier. DeepSeek retired the id on 2026-07-24, so without this
    // migration every request 400s and reads to the user as "my API key stopped working" (MQA tracked).
    setSettings({
      provider: 'deepseek',
      providerModels: { deepseek: 'deepseek-chat' },
      providerModelsThinking: { deepseek: 'deepseek-reasoner' }
    })

    const healed = getSettings()
    expect(healed.providerModels.deepseek).toBe('deepseek-v4-flash')
    expect(healed.providerModelsThinking.deepseek).toBe('deepseek-v4-flash')
  })

  it('leaves a live model id and an unrelated provider override untouched', () => {
    setSettings({ providerModels: { deepseek: 'deepseek-v4-pro', anthropic: 'claude-opus-4-8' } })

    const s = getSettings()
    expect(s.providerModels.deepseek).toBe('deepseek-v4-pro')
    expect(s.providerModels.anthropic).toBe('claude-opus-4-8')
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

  describe('settings.json.recovered (survive an unreadable settings.json)', () => {
    it('preserves an undecryptable V2 settings file to .recovered and falls back to defaults', () => {
      const settingsFile = join(userData, 'settings.json')
      // A well-formed V2 marker followed by bytes that are not a valid AES-GCM envelope for this
      // install's key — decryptSecret must throw, exactly like a corrupted file or a rotated key.
      const garbage = Buffer.concat([ENC_V2, Buffer.from('not-a-valid-aes-gcm-ciphertext')])
      writeFileSync(settingsFile, garbage)

      const s = getSettings()
      // Falls back to defaults rather than throwing or bricking the app.
      expect(s.provider).toBe(DEFAULT_SETTINGS.provider)

      // The original undecryptable buffer was preserved verbatim before being discarded.
      const recoveredPath = `${settingsFile}.recovered`
      expect(existsSync(recoveredPath)).toBe(true)
      expect(readFileSync(recoveredPath)).toEqual(garbage)
    })

    it('returns a readable .recovered file\'s content when the main settings.json is corrupt', () => {
      const settingsFile = join(userData, 'settings.json')
      const garbage = Buffer.concat([ENC_V2, Buffer.from('another-invalid-ciphertext-blob')])
      writeFileSync(settingsFile, garbage)
      // A previously-preserved recovery copy, in the legacy plaintext format — readable regardless of
      // which encryption backend is active for this test run.
      writeFileSync(`${settingsFile}.recovered`, JSON.stringify({ provider: 'openai', temperature: 0.42 }), 'utf8')

      const s = getSettings()
      expect(s.provider).toBe('openai')
      expect(s.temperature).toBe(0.42)
    })

    it('preserves nothing and creates no .recovered file when settings.json has never existed', () => {
      const settingsFile = join(userData, 'settings.json')
      // userData is a fresh temp dir — settings.json was never written, so readUserRaw hits ENOENT.
      const s = getSettings()
      expect(s.provider).toBe(DEFAULT_SETTINGS.provider)
      expect(existsSync(`${settingsFile}.recovered`)).toBe(false)
    })
  })

  describe('mcpConnections migration from legacy bidstackEndpointUrl/bidstackConnected/bidstackTools', () => {
    it('synthesizes a mcpConnections[0] entry from the legacy fields on read', () => {
      const settingsFile = join(userData, 'settings.json')
      writeFileSync(
        settingsFile,
        JSON.stringify({
          bidstackEndpointUrl: 'http://localhost:4001/mcp',
          bidstackConnected: true,
          bidstackTools: ['push_meeting_recap']
        }),
        'utf8'
      )

      const s = getSettings()
      expect(s.mcpConnections).toEqual([
        {
          id: 'bidstack',
          kind: 'bidstack',
          label: 'Polo Pre-Sales',
          endpointUrl: 'http://localhost:4001/mcp',
          connected: true,
          tools: ['push_meeting_recap'],
          extraHeaders: {}
        }
      ])
    })

    it('does nothing when there is no legacy endpoint to migrate', () => {
      const s = getSettings()
      expect(s.mcpConnections).toEqual([])
    })

    it('never re-populates mcpConnections once the user explicitly cleared it (a real disconnect)', () => {
      const settingsFile = join(userData, 'settings.json')
      // Legacy fields are still present on disk (never actively cleaned up), but the user has since
      // disconnected through the new UI, which persisted an explicit empty mcpConnections array.
      writeFileSync(
        settingsFile,
        JSON.stringify({
          bidstackEndpointUrl: 'http://localhost:4001/mcp',
          bidstackConnected: true,
          bidstackTools: ['push_meeting_recap'],
          mcpConnections: []
        }),
        'utf8'
      )

      const s = getSettings()
      expect(s.mcpConnections).toEqual([])
    })

    it('leaves a real (non-legacy) mcpConnections entry untouched', () => {
      const settingsFile = join(userData, 'settings.json')
      writeFileSync(
        settingsFile,
        JSON.stringify({
          bidstackEndpointUrl: 'http://localhost:4001/mcp',
          bidstackConnected: true,
          bidstackTools: ['push_meeting_recap'],
          mcpConnections: [
            {
              id: 'plane',
              kind: 'plane',
              label: 'Plane',
              endpointUrl: 'https://mcp.plane.so/http/api-key/mcp',
              connected: true,
              tools: ['workitem'],
              extraHeaders: { 'X-Workspace-slug': 'acme' }
            }
          ]
        }),
        'utf8'
      )

      const s = getSettings()
      expect(s.mcpConnections).toEqual([
        {
          id: 'plane',
          kind: 'plane',
          label: 'Plane',
          endpointUrl: 'https://mcp.plane.so/http/api-key/mcp',
          connected: true,
          tools: ['workitem'],
          extraHeaders: { 'X-Workspace-slug': 'acme' }
        }
      ])
    })
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

  // Cloudflare is the one provider whose endpoint Métis cannot know: each operator deploys their own
  // Worker (holding the Cloudflare ACCOUNT token as a Wrangler secret) and hands out a METIS_PROXY_KEY.
  describe('Cloudflare — operator-supplied endpoint', () => {
    it('refuses to Test a key before the Worker URL is set, without making a network call', async () => {
      // Without this guard the OpenAI SDK falls back to its own default base URL (api.openai.com) and the
      // "Test" button would send the METIS_PROXY_KEY to OpenAI. A sandboxed test has no network, so the
      // specific message (not a connection error) is what proves the guard fired first.
      setSettings({ cloudflareBaseUrl: '' })

      const result = await testApiKey('cloudflare', 'operator-issued-proxy-secret')

      expect(result.ok).toBe(false)
      expect(result.error).toBe('Cloudflare needs your Worker URL in Advanced settings first.')
    })

    it('stores the METIS_PROXY_KEY through the same encrypted path as every other provider key', async () => {
      // The per-user proxy key is a credential, so it must never land in settings.json next to the URL.
      setApiKey('cloudflare', 'operator-issued-proxy-secret')
      setSettings({ cloudflareBaseUrl: 'https://metis-ai.example.workers.dev/v1' })

      expect(getApiKey('cloudflare')).toBe('operator-issued-proxy-secret')
      const persisted = readPersisted(join(userData, 'settings.json'))
      expect(JSON.stringify(persisted)).not.toContain('operator-issued-proxy-secret')
      // The endpoint itself is not a secret and does belong in settings.
      expect(persisted.cloudflareBaseUrl).toBe('https://metis-ai.example.workers.dev/v1')
    })

    it('MQA-213: Test shows the operator sentence, and never the routing marker that carries it', async () => {
      setSettings({ cloudflareBaseUrl: 'https://metis-ai.example.workers.dev/v1' })
      // What the Worker actually puts on the wire when Cloudflare rejects the OPERATOR's account token.
      // The '[metis-proxy-config]' prefix exists so the ask path can tell an operator fault from an
      // ordinary 502 blip; it is routing plumbing, and a user cannot act on it.
      chatCompletionsCreate.mockRejectedValue(
        new Error(
          '502 [metis-proxy-config] Cloudflare rejected this proxy account credential. The operator needs to check CLOUDFLARE_API_TOKEN and CF_ACCOUNT_ID.'
        )
      )

      const result = await testApiKey('cloudflare', 'operator-issued-proxy-secret')

      expect(result.ok).toBe(false)
      expect(result.error).toContain('The operator needs to check CLOUDFLARE_API_TOKEN')
      expect(result.error).not.toContain('[metis-proxy-config]')
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

  // MQA-060 (docs/qa/BUG-LEDGER.md): the Settings input is cleared after a save and never re-renders the
  // secret, so a Test with an empty box must fall back to the STORED key — otherwise the button could only
  // test a freshly pasted key, never the one actually in use.
  describe('testApiKey falls back to the stored key when none is passed (MQA-060)', () => {
    it('tests the saved key on an empty argument instead of returning "No API key provided"', async () => {
      setApiKey('openai', 'sk-stored-openai-key')
      // A dummy allowlist-free env: the network call would run, so pin the allowlist to include openai and
      // assert we got PAST the empty-key floor (the org gate / network is what runs next, not the floor).
      const managed = join(userData, 'managed-config.json')
      writeFileSync(managed, JSON.stringify({ allowedProviders: ['dust'] }), 'utf8') // excludes openai
      const result = await testApiKey('openai', '   ') // empty/whitespace → should use the stored key

      // It reached the allowlist gate (proving the stored key was picked up), not the empty-key floor.
      expect(result.error).not.toBe('No API key provided.')
      expect(result.error).toBe("GPT · OpenAI is not on your organization's approved provider list.")
    })

    it('still returns the no-key error when the box is empty AND nothing is stored', async () => {
      // 'grok' is never set in this block, so the module-level _apiKeyCache cannot leak a stored key into
      // this assertion the way reusing 'openai' from the test above would (see the env-var/cache note in
      // this file's beforeEach).
      const result = await testApiKey('grok', '')
      expect(result).toEqual({ ok: false, error: 'No API key provided.' })
    })
  })

  describe('Cahê Windows edition policy', () => {
    const caheFlag = 'METIS_CAHE_EDITION'
    let previousCaheFlag: string | undefined

    beforeEach(() => {
      previousCaheFlag = process.env[caheFlag]
      process.env[caheFlag] = '1'
    })

    afterEach(() => {
      if (previousCaheFlag === undefined) delete process.env[caheFlag]
      else process.env[caheFlag] = previousCaheFlag
    })

    it('lets the user switch away from Kimi to any other provider — no edition-level lock', () => {
      // Cahê's implicit policy is now identical to a non-Cahê build: no allowlist, no locked keys, no
      // forced managed defaults. Kimi is only the pilot's OUT-OF-BOX default (seeded once by
      // cahe-embedded-key.ts), not a standing lock — a real switch to Dust (or Claude CLI/Codex CLI/any
      // API-key provider) must persist exactly like it would outside the Cahê edition.
      const result = setSettings({
        provider: 'dust',
        providerPriority: 'cli',
        dustWorkspaceId: 'cahe-workspace',
        providerModels: { ...DEFAULT_SETTINGS.providerModels, dust: 'cahe-dust-agent' }
      })

      expect(result.provider).toBe('dust')
      expect(result.providerPriority).toBe('cli')
      expect(result.dustWorkspaceId).toBe('cahe-workspace')
      expect(result.providerModels.dust).toBe('cahe-dust-agent')
      expect(getAllowedProviders()).toBeNull()
      expect(getLockedKeys()).toEqual([])
    })

    it('stores a Cahê Kimi key encrypted in the isolated local profile', () => {
      const key = 'sk-kimi-local-test-key'
      setApiKey('kimi', key)

      const persisted = readFileSync(join(userData, 'key-kimi.bin')).toString('utf8')
      expect(getApiKey('kimi')).toBe(key)
      expect(persisted).not.toContain(key)
    })
  })
})
