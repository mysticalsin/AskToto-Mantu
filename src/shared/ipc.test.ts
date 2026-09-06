import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  AskStartSchema,
  CaptureResultSchema,
  ScreenContextResultSchema,
  ScreenCaptureCheckPayloadSchema,
  ScreenCaptureCheckResultSchema,
  SettingsSchema,
  DEFAULT_SETTINGS,
  IPC,
  McpConnectionSchema,
  McpTestConnectionPayloadSchema,
  McpSaveConnectionPayloadSchema,
  McpDisconnectPayloadSchema,
  McpPushPayloadSchema,
  RecapExportSchema,
  StreamMetaSchema,
  EntityRenamePayloadSchema,
  EntityMergePayloadSchema,
  EntityUnmergePayloadSchema,
  EntityUpdateFieldPayloadSchema,
  FieldDecisionPayloadSchema,
  BrainConnectPayloadSchema,
  CommitmentRejectPayloadSchema,
  MeetingExtractionQuerySchema,
  AttentionItemSchema,
  BrainAttentionResultSchema,
  appendAsrCorrection,
  TranscriptLineSchema,
  stripProvisionalLines
} from './ipc'
import type { TranscriptLine } from './ipc'

/** process.platform is configurable in Node — flip it for the duration of a platform-specific test. */
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

describe('AskStartSchema', () => {
  it('accepts a valid vision payload with a small base64 PNG', () => {
    const valid = {
      id: 'ask-1',
      mode: 'vision' as const,
      prompt: 'describe this',
      image: Buffer.alloc(100).toString('base64'),
      history: []
    }
    const result = AskStartSchema.safeParse(valid)
    expect(result.success).toBe(true)
  })

  it('rejects an oversized image', () => {
    // The string is both longer than the 5 MB limit and not base64-valid,
    // so it is rejected. Using a valid multi-megabyte base64 string would
    // trip V8's regex stack limit in Zod's base64 validator.
    const oversized = {
      id: 'ask-2',
      mode: 'vision' as const,
      image: '!'.repeat(5_000_001),
      history: []
    }
    const result = AskStartSchema.safeParse(oversized)
    expect(result.success).toBe(false)
  })

  it('rejects a non-base64 image string', () => {
    const invalid = {
      id: 'ask-3',
      mode: 'vision' as const,
      image: 'not-valid-base64!!!',
      history: []
    }
    const result = AskStartSchema.safeParse(invalid)
    expect(result.success).toBe(false)
  })

  it('accepts only a UUID localSessionId', () => {
    const base = { id: 'ask-4', mode: 'answer' as const, history: [] }
    expect(
      AskStartSchema.safeParse({ ...base, localSessionId: '123e4567-e89b-12d3-a456-426614174000' }).success
    ).toBe(true)
    expect(AskStartSchema.safeParse({ ...base, localSessionId: 'not-a-uuid' }).success).toBe(false)
  })

  it('accepts bounded structured visionEvidence only for vision mode and without a raw image', () => {
    const visionEvidence = {
      version: 1,
      modelId: 'smolvlm-256m-instruct',
      modelSha256: 'a'.repeat(64),
      capturedAt: 1,
      backend: 'wasm' as const,
      capabilities: ['caption'] as const,
      caption: 'A roadmap slide',
      text: '',
      regions: []
    }
    expect(
      AskStartSchema.safeParse({ id: 'ask-5', mode: 'vision', visionEvidence, history: [] }).success
    ).toBe(true)
    expect(
      AskStartSchema.safeParse({ id: 'ask-6', mode: 'answer', visionEvidence, history: [] }).success
    ).toBe(false)
    expect(
      AskStartSchema.safeParse({
        id: 'ask-7',
        mode: 'vision',
        visionEvidence,
        image: Buffer.alloc(100).toString('base64'),
        history: []
      }).success
    ).toBe(false)
    expect(
      AskStartSchema.safeParse({
        id: 'ask-7-empty-image',
        mode: 'vision',
        visionEvidence,
        image: '',
        history: []
      }).success
    ).toBe(false)
  })

  it('rejects visionEvidence whose complete JSON exceeds 64 KiB UTF-8', () => {
    const visionEvidence = {
      version: 1,
      modelId: 'smolvlm-256m-instruct',
      modelSha256: 'a'.repeat(64),
      capturedAt: 1,
      backend: 'wasm' as const,
      capabilities: ['regions'] as const,
      caption: '',
      text: '',
      regions: Array.from({ length: 200 }, () => ({ text: 'é'.repeat(400), box: [0, 0, 1, 1] }))
    }
    expect(new TextEncoder().encode(JSON.stringify(visionEvidence)).length).toBeGreaterThan(64 * 1024)
    expect(AskStartSchema.safeParse({ id: 'ask-8', mode: 'vision', visionEvidence, history: [] }).success).toBe(false)
  })
})

describe('CaptureResultSchema', () => {
  it('requires a capturedAt timestamp for screen freshness UI', () => {
    const parsed = CaptureResultSchema.safeParse({
      image: Buffer.alloc(100).toString('base64'),
      width: 1280,
      height: 720,
      capturedAt: 1_700_000_000_000
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.capturedAt).toBe(1_700_000_000_000)
    }
  })
})

describe('screen-capture self-check IPC', () => {
  it('accepts probe and vision passes only', () => {
    expect(ScreenCaptureCheckPayloadSchema.safeParse({ pass: 'probe' }).success).toBe(true)
    expect(ScreenCaptureCheckPayloadSchema.safeParse({ pass: 'vision' }).success).toBe(true)
    expect(ScreenCaptureCheckPayloadSchema.safeParse({ pass: 'retry' }).success).toBe(false)
    expect(IPC.screenCaptureCheck).toBe('permissions:screenCaptureCheck')
  })

  it('names the backend that answered and stays a local result', () => {
    const parsed = ScreenCaptureCheckResultSchema.safeParse({
      ok: true,
      pass: 'vision',
      backend: 'local',
      backendLabel: 'Métis Local · on-device',
      failedOver: false,
      message: 'Métis Local · on-device can see the screen.',
      preview: 'a Settings window'
    })
    expect(parsed.success).toBe(true)
  })
})

describe('ScreenContextResultSchema (M13 screen fast-path)', () => {
  it('accepts a description + capturedAt, or null', () => {
    expect(ScreenContextResultSchema.safeParse({ description: 'a code editor', capturedAt: 1_700_000_000_000 }).success).toBe(true)
    expect(ScreenContextResultSchema.safeParse(null).success).toBe(true)
    expect(ScreenContextResultSchema.safeParse({ description: 'x', capturedAt: -1 }).success).toBe(false)
  })
})

describe('AskStart screen fast-path fields (M13)', () => {
  it('accepts the wantsScreenContext intent flag and a main-injected screenContext', () => {
    const parsed = AskStartSchema.safeParse({
      id: 'ask-sc',
      mode: 'answer',
      prompt: 'what am I looking at?',
      wantsScreenContext: true,
      screenContext: 'A spreadsheet with quarterly figures.',
      history: []
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.wantsScreenContext).toBe(true)
      expect(parsed.data.screenContext).toContain('spreadsheet')
    }
  })

  it('caps screenContext length (defense against a hostile renderer)', () => {
    const parsed = AskStartSchema.safeParse({
      id: 'ask-big',
      mode: 'answer',
      prompt: 'q',
      screenContext: 'x'.repeat(8001),
      history: []
    })
    expect(parsed.success).toBe(false)
  })
})

describe('SettingsSchema', () => {
  it('defaults lastClickedCli to null — not a secret, not a vault row', () => {
    expect(DEFAULT_SETTINGS.lastClickedCli).toBeNull()
    const { lastClickedCli: _last, ...withoutLast } = DEFAULT_SETTINGS
    expect(SettingsSchema.parse(withoutLast).lastClickedCli).toBeNull()
  })

  it('defaults the time-saved usage counters and assumption, and a profile without them parses', () => {
    const s = SettingsSchema.parse(DEFAULT_SETTINGS)
    expect(s.usageStats).toEqual({ meetingsSummarized: 0, conversationMinutes: 0, firstMeetingAt: 0 })
    expect(s.timeSaved).toEqual({ writeupRatio: 0.2, floorMin: 5, capMin: 30 })
    // A persisted profile from before these fields existed must parse and get the defaults, not throw.
    const { usageStats: _u, timeSaved: _t, ...withoutNew } = DEFAULT_SETTINGS
    const parsed = SettingsSchema.parse(withoutNew)
    expect(parsed.usageStats.meetingsSummarized).toBe(0)
    expect(parsed.timeSaved.writeupRatio).toBe(0.2)
  })

  it('defaults backgroundScreenContext OFF — continuous screen capture is its own opt-in', () => {
    expect(DEFAULT_SETTINGS.backgroundScreenContext).toBe(false)
    expect(SettingsSchema.parse(DEFAULT_SETTINGS).backgroundScreenContext).toBe(false)
    // Local AI is also off by default — both must stay false so a fresh install never starts
    // continuous screen capture as a side effect of another default.
    expect(DEFAULT_SETTINGS.localLlm.enabled).toBe(false)
    expect(
      DEFAULT_SETTINGS.localLlm.enabled && DEFAULT_SETTINGS.backgroundScreenContext
    ).toBe(false)
  })

  it('rejects custom provider with an empty base URL', () => {
    const invalid = {
      ...DEFAULT_SETTINGS,
      provider: 'custom' as const,
      customBaseUrl: ''
    }
    const result = SettingsSchema.safeParse(invalid)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('customBaseUrl'))).toBe(true)
    }
  })

  it('rejects custom provider with a non-https base URL', () => {
    const invalid = {
      ...DEFAULT_SETTINGS,
      provider: 'custom' as const,
      customBaseUrl: 'http://example.com'
    }
    const result = SettingsSchema.safeParse(invalid)
    expect(result.success).toBe(false)
  })

  it('accepts custom provider with a valid https base URL', () => {
    const valid = {
      ...DEFAULT_SETTINGS,
      provider: 'custom' as const,
      customBaseUrl: 'https://api.example.com/v1'
    }
    const result = SettingsSchema.safeParse(valid)
    expect(result.success).toBe(true)
  })

  it('ships the Worker ENDPOINT but never a credential — the distinction the whole design rests on', () => {
    // A packaged Electron app cannot keep a secret: `npx asar extract` recovers any embedded string. A
    // URL is not a secret, so presetting the operator's Worker endpoint costs nothing and saves the user
    // pasting a second string. The Cloudflare ACCOUNT token is the thing that must never ship, and it
    // does not: it lives as a Wrangler secret ON that Worker. What a user still pastes is their
    // METIS_PROXY_KEY, which goes to the encrypted key store, never to settings.
    const preset = SettingsSchema.parse(DEFAULT_SETTINGS).cloudflareBaseUrl
    expect(preset).toBe(DEFAULT_SETTINGS.cloudflareBaseUrl)
    expect(preset).toMatch(/^https:\/\//)
    expect(preset.replace(/\/+$/, '')).toMatch(/\/v1$/)
    // No credential may hide in the endpoint: no userinfo, no query string carrying a key.
    expect(preset).not.toMatch(/@/)
    expect(preset).not.toMatch(/[?&](key|token|secret|api[-_]?key)=/i)
    // And nothing token-shaped is anywhere in the shipped defaults.
    const asJson = JSON.stringify(DEFAULT_SETTINGS)
    expect(asJson).not.toMatch(/cfut_|CLOUDFLARE_API_TOKEN|Bearer /)
  })

  it('rejects a non-https Cloudflare Worker URL', () => {
    // The METIS_PROXY_KEY rides this connection in an Authorization header — plaintext http would leak it.
    const invalid = { ...DEFAULT_SETTINGS, cloudflareBaseUrl: 'http://worker.example.com/v1' }
    const result = SettingsSchema.safeParse(invalid)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('cloudflareBaseUrl'))).toBe(true)
    }
  })

  it('accepts an https Cloudflare Worker URL', () => {
    const valid = { ...DEFAULT_SETTINGS, cloudflareBaseUrl: 'https://metis-ai.example.workers.dev/v1' }
    expect(SettingsSchema.safeParse(valid).success).toBe(true)
  })

  it("selecting Cloudflare before its URL is set still parses — readiness is enforced at request time", () => {
    // Deliberately unlike provider:'custom', whose cross-field refine makes a bare provider patch fail the
    // full-object re-parse — which is why Settings.tsx has to seed a placeholder URL for it. Cloudflare
    // needs no such workaround: publicSettings().providerReady, attempt()'s eligibility chain and
    // pickFailover all require the https endpoint, so an unconfigured Cloudflare never gets a request.
    const midSetup = { ...DEFAULT_SETTINGS, provider: 'cloudflare' as const, cloudflareBaseUrl: '' }
    expect(SettingsSchema.safeParse(midSetup).success).toBe(true)
  })

  it('accepts the default settings', () => {
    const result = SettingsSchema.safeParse(DEFAULT_SETTINGS)
    expect(result.success).toBe(true)
  })

  it('defaults playListenChime, requireConsentIndicator, and lastConsentReminderAt', () => {
    expect(DEFAULT_SETTINGS.operatorUrl).toBe('')
    expect(DEFAULT_SETTINGS.operatorIngestSecret).toBe('')
    expect(DEFAULT_SETTINGS.sendAskText).toBe(true)
    expect(SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, operatorUrl: 'http://not-https.example' }).success).toBe(
      false
    )
    expect(
      SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, operatorUrl: 'https://metis-operator.example.workers.dev' })
        .success
    ).toBe(true)
    expect(DEFAULT_SETTINGS.playListenChime).toBe(true)
    // On by default: it's the only consent mechanism Métis has, so the persistent reminder should be
    // the opt-out, not the opt-in (mirrors the encryptTranscripts default-flip reasoning).
    expect(DEFAULT_SETTINGS.requireConsentIndicator).toBe(true)
    expect(DEFAULT_SETTINGS.lastConsentReminderAt).toBe(0)
    const parsed = SettingsSchema.safeParse(DEFAULT_SETTINGS)
    expect(parsed.success).toBe(true)
  })

  it('parses new consent/recording settings when provided (including turning the indicator off)', () => {
    const parsed = SettingsSchema.safeParse({
      ...DEFAULT_SETTINGS,
      playListenChime: false,
      requireConsentIndicator: false,
      lastConsentReminderAt: 1700000000000
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.playListenChime).toBe(false)
      expect(parsed.data.requireConsentIndicator).toBe(false)
      expect(parsed.data.lastConsentReminderAt).toBe(1700000000000)
    }
  })

  it('defaults mcpConnections to an empty array', () => {
    expect(DEFAULT_SETTINGS.mcpConnections).toEqual([])
  })

  it('defaults planeClientId to empty (main-owned DCR cache)', () => {
    expect(DEFAULT_SETTINGS.planeClientId).toBe('')
    expect(SettingsSchema.parse({ ...DEFAULT_SETTINGS }).planeClientId).toBe('')
    expect(IPC.mcpPlaneConnect).toBe('mcp:planeConnect')
    expect(IPC.mcpClickupDiscoverDestination).toBe('mcp:clickupDiscoverDestination')
  })

  it('defaults asrQuality to best (live Whisper uses the large multilingual model)', () => {
    expect(DEFAULT_SETTINGS.asrQuality).toBe('best')
    // Schema default must match DEFAULT_SETTINGS — store.ts layers defaults under the user file, then
    // parses; keep both identical so neither lies (see ipc.ts comment on asrQuality).
    const { asrQuality: _omit, ...withoutQuality } = DEFAULT_SETTINGS
    expect(SettingsSchema.parse(withoutQuality).asrQuality).toBe('best')
  })

  it('defaults asrEngine to parakeet (schema + DEFAULT_SETTINGS stay identical)', () => {
    expect(DEFAULT_SETTINGS.asrEngine).toBe('parakeet')
    const { asrEngine: _omit, ...withoutEngine } = DEFAULT_SETTINGS
    expect(SettingsSchema.parse(withoutEngine).asrEngine).toBe('parakeet')
    expect(IPC.asrAssetsStatus).toBe('asr:assets-status')
    expect(IPC.asrAssetsEnsure).toBe('asr:assets-ensure')
  })
})

// Generalized MCP push connections (BidStack CRM + Plane "Book next steps") — McpConnectionSchema is the
// persisted shape in settings.mcpConnections; the Test/Save/Disconnect/Push payload schemas are what
// index.ts's mcp:* handlers run every incoming payload through before ever touching the network or
// persisting anything.
describe('McpConnectionSchema', () => {
  it('round-trips a full BidStack-kind connection (no extra headers)', () => {
    const conn = {
      id: 'bidstack',
      kind: 'bidstack' as const,
      label: 'Polo Pre-Sales',
      endpointUrl: 'http://localhost:4001/mcp',
      connected: true,
      tools: ['push_meeting_recap'],
      extraHeaders: {}
    }
    const r = McpConnectionSchema.safeParse(conn)
    expect(r.success).toBe(true)
    if (r.success) expect(r.data).toEqual(conn)
  })

  it('round-trips a Plane-kind connection carrying the X-Workspace-slug extra header', () => {
    const conn = {
      id: 'plane',
      kind: 'plane' as const,
      label: 'Plane',
      endpointUrl: 'https://mcp.plane.so/http/api-key/mcp',
      connected: true,
      tools: ['workitem'],
      extraHeaders: { 'X-Workspace-slug': 'acme' }
    }
    const r = McpConnectionSchema.safeParse(conn)
    expect(r.success).toBe(true)
    if (r.success) expect(r.data).toEqual(conn)
  })

  it('accepts the schema-reserved clickup kind (no UI/IPC wiring yet, but the shape parses)', () => {
    expect(McpConnectionSchema.safeParse({ id: 'clickup', kind: 'clickup', label: 'ClickUp' }).success).toBe(true)
  })

  it('stores the last ClickUp list on the connection (destination is main-owned)', () => {
    const r = McpConnectionSchema.safeParse({
      id: 'clickup',
      kind: 'clickup',
      label: 'ClickUp',
      clickupListId: '901419032720',
      clickupListName: 'Project 1'
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.clickupListId).toBe('901419032720')
      expect(r.data.clickupListName).toBe('Project 1')
    }
  })

  it('rejects an unknown kind and an empty id/label', () => {
    expect(McpConnectionSchema.safeParse({ id: 'x', kind: 'jira', label: 'Jira' }).success).toBe(false)
    expect(McpConnectionSchema.safeParse({ id: '', kind: 'bidstack', label: 'X' }).success).toBe(false)
    expect(McpConnectionSchema.safeParse({ id: 'bidstack', kind: 'bidstack', label: '' }).success).toBe(false)
  })

  // The id is interpolated into mcpSecrets.ts's `key-mcp-<id>.bin`, so a free-string id is a path
  // traversal primitive: '../../secret-key' would target the AES file key that every stored provider
  // credential is encrypted under. Constrained to the kind enum at every entry point.
  it('rejects a path-traversing connection id everywhere a connectionId is accepted', () => {
    for (const id of ['../../secret-key', '..\\..\\secret-key', 'a/b', 'bidstack/../x']) {
      expect(McpConnectionSchema.safeParse({ id, kind: 'bidstack', label: 'X' }).success, `McpConnection ${id}`).toBe(false)
      expect(McpDisconnectPayloadSchema.safeParse({ connectionId: id }).success, `disconnect ${id}`).toBe(false)
      expect(
        McpPushPayloadSchema.safeParse({ connectionId: id, toolName: 't', args: {} }).success,
        `push ${id}`
      ).toBe(false)
    }
    // The real ids still pass on each of those entry points.
    for (const id of ['bidstack', 'plane', 'clickup']) {
      expect(McpDisconnectPayloadSchema.safeParse({ connectionId: id }).success, `disconnect ${id}`).toBe(true)
      expect(McpPushPayloadSchema.safeParse({ connectionId: id, toolName: 't', args: {} }).success, `push ${id}`).toBe(true)
    }
  })

  it('defaults endpointUrl/connected/tools/extraHeaders when only id+kind+label are given', () => {
    const r = McpConnectionSchema.safeParse({ id: 'plane', kind: 'plane', label: 'Plane' })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.endpointUrl).toBe('')
      expect(r.data.connected).toBe(false)
      expect(r.data.tools).toEqual([])
      expect(r.data.extraHeaders).toEqual({})
    }
  })

  it('a settings.mcpConnections array round-trips through the full SettingsSchema', () => {
    const conns = [
      {
        id: 'bidstack',
        kind: 'bidstack' as const,
        label: 'Polo Pre-Sales',
        endpointUrl: 'http://localhost:4001/mcp',
        connected: true,
        tools: [],
        extraHeaders: {}
      }
    ]
    const parsed = SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, mcpConnections: conns })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.mcpConnections).toEqual(conns)
  })
})

describe('McpTestConnectionPayloadSchema / McpSaveConnectionPayloadSchema / McpDisconnectPayloadSchema', () => {
  it('accepts a valid connectionId + endpoint + key', () => {
    const r = McpTestConnectionPayloadSchema.safeParse({
      connectionId: 'bidstack',
      endpointUrl: 'http://localhost:4001/mcp',
      apiKey: 'sk-bidstack-abc'
    })
    expect(r.success).toBe(true)
  })

  it('defaults extraHeaders to {} when omitted, and accepts it when given (Plane workspace header)', () => {
    const base = { connectionId: 'plane', endpointUrl: 'https://mcp.plane.so/http/api-key/mcp', apiKey: 'sk-abc' }
    const r1 = McpTestConnectionPayloadSchema.safeParse(base)
    expect(r1.success).toBe(true)
    if (r1.success) expect(r1.data.extraHeaders).toEqual({})
    const r2 = McpTestConnectionPayloadSchema.safeParse({ ...base, extraHeaders: { 'X-Workspace-slug': 'acme' } })
    expect(r2.success).toBe(true)
    if (r2.success) expect(r2.data.extraHeaders).toEqual({ 'X-Workspace-slug': 'acme' })
  })

  it('rejects a missing connectionId, an empty endpoint URL, and an empty API key', () => {
    expect(McpTestConnectionPayloadSchema.safeParse({ endpointUrl: 'http://localhost:4001/mcp', apiKey: 'x' }).success).toBe(false)
    expect(McpTestConnectionPayloadSchema.safeParse({ connectionId: 'bidstack', endpointUrl: '', apiKey: 'sk-abc' }).success).toBe(false)
    expect(
      McpTestConnectionPayloadSchema.safeParse({ connectionId: 'bidstack', endpointUrl: 'http://localhost:4001/mcp', apiKey: '' })
        .success
    ).toBe(false)
  })

  it('rejects a non-object payload (e.g. a compromised/malformed renderer message)', () => {
    expect(McpTestConnectionPayloadSchema.safeParse(null).success).toBe(false)
    expect(McpTestConnectionPayloadSchema.safeParse('http://localhost:4001/mcp').success).toBe(false)
    expect(McpTestConnectionPayloadSchema.safeParse(undefined).success).toBe(false)
  })

  it('SaveConnection extends TestConnection with a required label', () => {
    const base = { connectionId: 'bidstack', endpointUrl: 'http://localhost:4001/mcp', apiKey: 'sk-abc' }
    expect(McpSaveConnectionPayloadSchema.safeParse(base).success).toBe(false) // missing label
    expect(McpSaveConnectionPayloadSchema.safeParse({ ...base, label: 'Polo Pre-Sales' }).success).toBe(true)
  })

  it('Disconnect only requires a connectionId', () => {
    expect(McpDisconnectPayloadSchema.safeParse({ connectionId: 'plane' }).success).toBe(true)
    expect(McpDisconnectPayloadSchema.safeParse({}).success).toBe(false)
  })
})

describe('McpPushPayloadSchema', () => {
  it('accepts a connectionId + tool name with a plain args record', () => {
    const r = McpPushPayloadSchema.safeParse({
      connectionId: 'bidstack',
      toolName: 'push_meeting_recap',
      args: { title: 'Q3 sync', date: '2026-06-30', summary: 'Recap text.' }
    })
    expect(r.success).toBe(true)
  })

  it('accepts empty args', () => {
    const r = McpPushPayloadSchema.safeParse({ connectionId: 'bidstack', toolName: 'push_meeting_recap', args: {} })
    expect(r.success).toBe(true)
  })

  it('rejects a missing connectionId', () => {
    const r = McpPushPayloadSchema.safeParse({ toolName: 'push_meeting_recap', args: {} })
    expect(r.success).toBe(false)
  })

  it('rejects an empty tool name — never silently pushes to an unspecified tool', () => {
    const r = McpPushPayloadSchema.safeParse({ connectionId: 'bidstack', toolName: '', args: {} })
    expect(r.success).toBe(false)
  })

  it('rejects a missing args field', () => {
    const r = McpPushPayloadSchema.safeParse({ connectionId: 'bidstack', toolName: 'push_meeting_recap' })
    expect(r.success).toBe(false)
  })

  it('rejects args that is not a record (e.g. an array or string)', () => {
    expect(McpPushPayloadSchema.safeParse({ connectionId: 'bidstack', toolName: 'x', args: [] }).success).toBe(false)
    expect(McpPushPayloadSchema.safeParse({ connectionId: 'bidstack', toolName: 'x', args: 'not-an-object' }).success).toBe(
      false
    )
  })

  it('rejects a nested object/array value inside args — flat primitives only', () => {
    const r = McpPushPayloadSchema.safeParse({ connectionId: 'bidstack', toolName: 'x', args: { nested: { a: 1 } } })
    expect(r.success).toBe(false)
  })

  it('rejects an oversized string value inside args', () => {
    const r = McpPushPayloadSchema.safeParse({
      connectionId: 'bidstack',
      toolName: 'x',
      args: { summary: 'a'.repeat(50_001) }
    })
    expect(r.success).toBe(false)
  })

  it('rejects an args object with too many fields', () => {
    const args: Record<string, string> = {}
    for (let i = 0; i < 21; i++) args[`field${i}`] = 'v'
    const r = McpPushPayloadSchema.safeParse({ connectionId: 'bidstack', toolName: 'x', args })
    expect(r.success).toBe(false)
  })

  it('accepts string/number/boolean/null primitive values within bounds', () => {
    const r = McpPushPayloadSchema.safeParse({
      connectionId: 'plane',
      toolName: 'x',
      args: { title: 'ok', count: 3, active: true, note: null }
    })
    expect(r.success).toBe(true)
  })
})

// "Book next steps" — RecapExportSchema.actionItems gains dueDateText (see parseRecapMarkdown's own
// dedicated coverage in main/transcripts.test.ts for the extraction regex itself; this is schema shape only).
describe('RecapExportSchema.actionItems dueDateText', () => {
  const base = {
    title24: 'Q3 sync',
    tags: [],
    overview: '',
    topics: [],
    keyQA: [],
    decisions: [],
    openQuestions: [],
    notableQuotes: [],
    markdown: ''
  }

  it('accepts a null dueDateText and a populated one', () => {
    const r = RecapExportSchema.safeParse({
      ...base,
      actionItems: [
        { text: 'Send the deck', owner: 'Alice', dueDateText: 'Friday' },
        { text: 'Finalize copy', owner: null, dueDateText: null }
      ]
    })
    expect(r.success).toBe(true)
  })

  it('rejects an actionItems entry missing dueDateText entirely', () => {
    const r = RecapExportSchema.safeParse({ ...base, actionItems: [{ text: 'x', owner: null }] })
    expect(r.success).toBe(false)
  })
})

// Correction engine (Task MI-2) IPC payload validation — this is what index.ts's five brain:entity*/
// brain:commitmentReject handlers run every incoming payload through before ever touching the store.
describe('EntityRenamePayloadSchema', () => {
  it('accepts a valid rename, with and without alsoFixAsr', () => {
    expect(EntityRenamePayloadSchema.safeParse({ kind: 'account', id: 'acme-corp', newName: 'Acme' }).success).toBe(true)
    expect(
      EntityRenamePayloadSchema.safeParse({ kind: 'person', id: 'm-silva', newName: 'Maria Silva', alsoFixAsr: true })
        .success
    ).toBe(true)
  })

  it('rejects an invalid kind, an empty id/newName, and a non-boolean alsoFixAsr', () => {
    expect(EntityRenamePayloadSchema.safeParse({ kind: 'meeting', id: 'x', newName: 'Y' }).success).toBe(false)
    expect(EntityRenamePayloadSchema.safeParse({ kind: 'account', id: '', newName: 'Y' }).success).toBe(false)
    expect(EntityRenamePayloadSchema.safeParse({ kind: 'account', id: 'x', newName: '' }).success).toBe(false)
    expect(
      EntityRenamePayloadSchema.safeParse({ kind: 'account', id: 'x', newName: 'Y', alsoFixAsr: 'yes' }).success
    ).toBe(false)
  })

  it('rejects a missing field entirely and a non-object payload', () => {
    expect(EntityRenamePayloadSchema.safeParse({ id: 'x', newName: 'Y' }).success).toBe(false)
    expect(EntityRenamePayloadSchema.safeParse(null).success).toBe(false)
  })

  // MI-2.5 Fix B: a path-traversal/non-slug id is rejected OUTRIGHT here, before the payload ever reaches
  // the main-process handler — defense in depth alongside corrections.ts's own slugify sanitization.
  it('rejects a path-traversal or otherwise non-slug id', () => {
    expect(EntityRenamePayloadSchema.safeParse({ kind: 'account', id: '../../../etc/hosts', newName: 'Y' }).success).toBe(
      false
    )
    expect(EntityRenamePayloadSchema.safeParse({ kind: 'account', id: 'Acme Corp', newName: 'Y' }).success).toBe(false) // spaces/uppercase — not a slug
    expect(EntityRenamePayloadSchema.safeParse({ kind: 'account', id: 'acme-corp', newName: 'Y' }).success).toBe(true) // a real slug still passes
  })

  // The pair alsoFixAsr composes in index.ts must round-trip through the SAME settings.asrCorrections
  // shape commitLine's consumer expects (lib/listen.ts: c.from / c.to, both plain strings).
  it('a constructed {from, to} correction pair round-trips through the persisted settings shape', () => {
    const pair = { from: 'Acme Corp', to: 'Acme' }
    const parsed = SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, asrCorrections: [pair] })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.asrCorrections).toEqual([pair])
  })
})

describe('EntityMergePayloadSchema', () => {
  it('accepts a valid merge and rejects a missing fromId/intoId or bad kind', () => {
    expect(EntityMergePayloadSchema.safeParse({ kind: 'deal', fromId: 'a', intoId: 'b' }).success).toBe(true)
    expect(EntityMergePayloadSchema.safeParse({ kind: 'deal', fromId: '', intoId: 'b' }).success).toBe(false)
    expect(EntityMergePayloadSchema.safeParse({ kind: 'deal', intoId: 'b' }).success).toBe(false)
    expect(EntityMergePayloadSchema.safeParse({ kind: 'invalid', fromId: 'a', intoId: 'b' }).success).toBe(false)
  })

  it('rejects a path-traversal fromId/intoId', () => {
    expect(EntityMergePayloadSchema.safeParse({ kind: 'deal', fromId: '../../secrets', intoId: 'b' }).success).toBe(
      false
    )
    expect(EntityMergePayloadSchema.safeParse({ kind: 'deal', fromId: 'a', intoId: '../../secrets' }).success).toBe(
      false
    )
  })
})

describe('EntityUnmergePayloadSchema', () => {
  it('accepts a non-negative integer targetSeq and rejects negative/fractional/missing', () => {
    expect(EntityUnmergePayloadSchema.safeParse({ targetSeq: 0 }).success).toBe(true)
    expect(EntityUnmergePayloadSchema.safeParse({ targetSeq: 3 }).success).toBe(true)
    expect(EntityUnmergePayloadSchema.safeParse({ targetSeq: -1 }).success).toBe(false)
    expect(EntityUnmergePayloadSchema.safeParse({ targetSeq: 1.5 }).success).toBe(false)
    expect(EntityUnmergePayloadSchema.safeParse({}).success).toBe(false)
  })
})

describe('EntityUpdateFieldPayloadSchema', () => {
  it('accepts any field name + unknown value shape here — corrections.ts validates per (kind, field)', () => {
    expect(
      EntityUpdateFieldPayloadSchema.safeParse({ kind: 'deal', id: 'acme-core', field: 'stage', value: 'contract' })
        .success
    ).toBe(true)
    expect(
      EntityUpdateFieldPayloadSchema.safeParse({
        kind: 'deal',
        id: 'acme-core',
        field: 'velocity',
        value: { signal: 'hard-calendar-gate', evidence: 'go/no-go June 3' }
      }).success
    ).toBe(true)
  })

  it('rejects an empty id/field and a missing kind', () => {
    expect(EntityUpdateFieldPayloadSchema.safeParse({ kind: 'deal', id: '', field: 'stage', value: 'x' }).success).toBe(
      false
    )
    expect(EntityUpdateFieldPayloadSchema.safeParse({ kind: 'deal', id: 'x', field: '', value: 'x' }).success).toBe(
      false
    )
    expect(EntityUpdateFieldPayloadSchema.safeParse({ id: 'x', field: 'stage', value: 'x' }).success).toBe(false)
  })

  it('rejects a path-traversal id', () => {
    expect(
      EntityUpdateFieldPayloadSchema.safeParse({ kind: 'deal', id: '../../secrets', field: 'stage', value: 'x' })
        .success
    ).toBe(false)
  })
})

describe('FieldDecisionPayloadSchema (brain:field-decision — dashboard suggestion accept/dismiss)', () => {
  it('accepts a valid accept/dismiss decision for any entity kind', () => {
    expect(
      FieldDecisionPayloadSchema.safeParse({ entityKind: 'deal', entityId: 'acme-core', field: 'stage', decision: 'accept' })
        .success
    ).toBe(true)
    expect(
      FieldDecisionPayloadSchema.safeParse({ entityKind: 'person', entityId: 'maria-silva', field: 'role', decision: 'dismiss' })
        .success
    ).toBe(true)
    expect(
      FieldDecisionPayloadSchema.safeParse({ entityKind: 'account', entityId: 'acme-corp', field: 'sector', decision: 'accept' })
        .success
    ).toBe(true)
  })

  it('rejects an invalid kind/decision and an empty entityId/field', () => {
    expect(
      FieldDecisionPayloadSchema.safeParse({ entityKind: 'meeting', entityId: 'x', field: 'stage', decision: 'accept' })
        .success
    ).toBe(false)
    expect(
      FieldDecisionPayloadSchema.safeParse({ entityKind: 'deal', entityId: 'x', field: 'stage', decision: 'maybe' }).success
    ).toBe(false)
    expect(
      FieldDecisionPayloadSchema.safeParse({ entityKind: 'deal', entityId: '', field: 'stage', decision: 'accept' }).success
    ).toBe(false)
    expect(
      FieldDecisionPayloadSchema.safeParse({ entityKind: 'deal', entityId: 'x', field: '', decision: 'accept' }).success
    ).toBe(false)
  })

  it('rejects a missing field entirely and a non-object payload', () => {
    expect(FieldDecisionPayloadSchema.safeParse({ entityId: 'x', field: 'stage', decision: 'accept' }).success).toBe(false)
    expect(FieldDecisionPayloadSchema.safeParse(null).success).toBe(false)
  })

  // Same defense-in-depth as EntityUpdateFieldPayloadSchema's id: a path-traversal/non-slug entityId is
  // rejected outright here, before the payload ever reaches the main-process handler.
  it('rejects a path-traversal or otherwise non-slug entityId', () => {
    expect(
      FieldDecisionPayloadSchema.safeParse({ entityKind: 'deal', entityId: '../../../etc/hosts', field: 'stage', decision: 'accept' })
        .success
    ).toBe(false)
    expect(
      FieldDecisionPayloadSchema.safeParse({ entityKind: 'deal', entityId: 'Acme Corp', field: 'stage', decision: 'accept' }).success
    ).toBe(false) // spaces/uppercase — not a slug
    expect(
      FieldDecisionPayloadSchema.safeParse({ entityKind: 'deal', entityId: 'acme-core', field: 'stage', decision: 'accept' }).success
    ).toBe(true) // a real slug still passes
  })
})

describe('CommitmentRejectPayloadSchema', () => {
  it('accepts personSlug + text with dealSlug optional, rejects an empty personSlug/text', () => {
    expect(CommitmentRejectPayloadSchema.safeParse({ personSlug: 'maria-silva', text: 'send the deck' }).success).toBe(
      true
    )
    expect(
      CommitmentRejectPayloadSchema.safeParse({ personSlug: 'maria-silva', dealSlug: 'acme-core', text: 'x' }).success
    ).toBe(true)
    expect(CommitmentRejectPayloadSchema.safeParse({ personSlug: '', text: 'x' }).success).toBe(false)
    expect(CommitmentRejectPayloadSchema.safeParse({ personSlug: 'maria-silva', text: '' }).success).toBe(false)
  })

  it('rejects a path-traversal personSlug/dealSlug', () => {
    expect(CommitmentRejectPayloadSchema.safeParse({ personSlug: '../../secrets', text: 'x' }).success).toBe(false)
    expect(
      CommitmentRejectPayloadSchema.safeParse({ personSlug: 'maria-silva', dealSlug: '../../secrets', text: 'x' })
        .success
    ).toBe(false)
  })
})

// Task MI-3 read-only channels: brain:meetingExtraction / brain:attention payload + result shapes.
describe('MeetingExtractionQuerySchema (brain:meetingExtraction)', () => {
  it('accepts a file path or basename', () => {
    expect(MeetingExtractionQuerySchema.safeParse({ file: 'meeting-2026-07-11.md' }).success).toBe(true)
    expect(MeetingExtractionQuerySchema.safeParse({ file: '/Users/x/Meetings/meeting.md' }).success).toBe(true)
  })

  it('rejects an empty/missing file and a non-object payload', () => {
    expect(MeetingExtractionQuerySchema.safeParse({ file: '' }).success).toBe(false)
    expect(MeetingExtractionQuerySchema.safeParse({}).success).toBe(false)
    expect(MeetingExtractionQuerySchema.safeParse(null).success).toBe(false)
    expect(MeetingExtractionQuerySchema.safeParse({ file: 42 }).success).toBe(false)
  })
})

describe('AttentionItemSchema / BrainAttentionResultSchema (brain:attention)', () => {
  const valid = {
    kind: 'ambiguous',
    entityKind: 'account',
    id: 'acme-corp',
    label: 'Acme Corp',
    detail: 'Sector: "banking" is unconfirmed (AMBIGUOUS)'
  }

  it('accepts every item kind and wraps into the {items} result', () => {
    for (const kind of ['lint', 'ambiguous', 'contradicted_pin', 'ingest_failed']) {
      expect(AttentionItemSchema.safeParse({ ...valid, kind }).success).toBe(true)
    }
    expect(BrainAttentionResultSchema.safeParse({ items: [valid] }).success).toBe(true)
    expect(BrainAttentionResultSchema.safeParse({ items: [] }).success).toBe(true)
  })

  it('rejects an unknown kind, a bad entityKind, an empty id, and a missing items array', () => {
    expect(AttentionItemSchema.safeParse({ ...valid, kind: 'other' }).success).toBe(false)
    expect(AttentionItemSchema.safeParse({ ...valid, entityKind: 'meeting' }).success).toBe(false)
    expect(AttentionItemSchema.safeParse({ ...valid, id: '' }).success).toBe(false)
    expect(BrainAttentionResultSchema.safeParse({}).success).toBe(false)
  })

  it('accepts an ingest_failed item with entityKind omitted — it is not entity-linked', () => {
    expect(
      AttentionItemSchema.safeParse({
        kind: 'ingest_failed',
        id: 'bad-meeting.md',
        label: 'bad-meeting.md',
        detail: 'Failed to index: Provider timeout'
      }).success
    ).toBe(true)
  })
})

// alsoFixAsr composition (reviewer IMPORTANT 3): a pair that fails element validation must be SKIPPED
// (rename still applied) — never appended, because store.ts's validKeysOnly drops the whole
// asrCorrections array when any one element fails, silently wiping every existing correction.
describe('appendAsrCorrection (alsoFixAsr composition)', () => {
  it('appends a valid pair in the exact consumer shape (commitLine correctionsRef: {from, to})', () => {
    const r = appendAsrCorrection([{ from: 'Old Co', to: 'New Co' }], 'Acme Corp', 'Acme')
    expect(r.kind).toBe('append')
    if (r.kind === 'append') {
      expect(r.pairs).toEqual([
        { from: 'Old Co', to: 'New Co' },
        { from: 'Acme Corp', to: 'Acme' }
      ])
      // The composed array must round-trip whole-array settings validation.
      expect(SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, asrCorrections: r.pairs }).success).toBe(true)
    }
  })

  it('skips (with a reason) a name over the 80-char cap instead of poisoning whole-array validation', () => {
    const longName = 'X'.repeat(81)
    const r = appendAsrCorrection([], longName, 'Acme')
    expect(r.kind).toBe('skipped')
    if (r.kind === 'skipped') expect(r.reason).toContain('80')
    // The failure mode the pre-validation prevents: one bad element fails the ENTIRE array parse,
    // which is exactly what store.ts's validKeysOnly would then drop wholesale.
    expect(
      SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, asrCorrections: [{ from: longName, to: 'Acme' }] }).success
    ).toBe(false)
  })

  it('no-ops on a duplicate pair and enforces the 100-entry cap on append', () => {
    const pair = { from: 'Acme Corp', to: 'Acme' }
    expect(appendAsrCorrection([pair], 'Acme Corp', 'Acme')).toEqual({ kind: 'noop' })

    const full = Array.from({ length: 100 }, (_, i) => ({ from: `word-${i}`, to: `fix-${i}` }))
    const r = appendAsrCorrection(full, 'Acme Corp', 'Acme')
    expect(r.kind).toBe('append')
    if (r.kind === 'append') {
      expect(r.pairs).toHaveLength(100) // oldest dropped, cap respected
      expect(r.pairs[99]).toEqual(pair)
      expect(SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, asrCorrections: r.pairs }).success).toBe(true)
    }
  })
})

describe('DEFAULT_SHORTCUTS scroll defaults', () => {
  const REAL_PLATFORM = process.platform

  afterEach(() => {
    setPlatform(REAL_PLATFORM)
    vi.resetModules()
  })

  it('avoids the Ctrl+Alt+Arrow Intel display-rotation collision on Windows', async () => {
    setPlatform('win32')
    vi.resetModules() // DEFAULT_SHORTCUTS is computed at module load — needs a fresh import to see the flip
    const { DEFAULT_SHORTCUTS } = await import('./ipc')
    expect(DEFAULT_SHORTCUTS['scroll-up']).not.toContain('Alt+Up')
    expect(DEFAULT_SHORTCUTS['scroll-up']).not.toMatch(/Control.*Alt|Alt.*Control/)
  })

  it('keeps CommandOrControl+Alt+Arrow on mac', async () => {
    setPlatform('darwin')
    vi.resetModules()
    const { DEFAULT_SHORTCUTS } = await import('./ipc')
    expect(DEFAULT_SHORTCUTS['scroll-up']).toBe('CommandOrControl+Alt+Up')
    expect(DEFAULT_SHORTCUTS['scroll-down']).toBe('CommandOrControl+Alt+Down')
    expect(DEFAULT_SHORTCUTS['scroll-left']).toBe('CommandOrControl+Alt+Left')
    expect(DEFAULT_SHORTCUTS['scroll-right']).toBe('CommandOrControl+Alt+Right')
  })
})

describe('local AI IPC channel constants', () => {
  it('defines the five exact on-device local-AI channel names without collisions', () => {
    expect(IPC.localAiStatus).toBe('local-ai:status')
    expect(IPC.localTranscriptBegin).toBe('local-ai:transcript:begin')
    expect(IPC.localTranscriptAppend).toBe('local-ai:transcript:append')
    expect(IPC.localTranscriptResync).toBe('local-ai:transcript:resync')
    expect(IPC.localTranscriptEnd).toBe('local-ai:transcript:end')
    const values = Object.values(IPC)
    expect(new Set(values).size).toBe(values.length)
  })
})

// ASR quality (Wave 1, 1B.2b) — `provisional` is an optional, additive field: every meeting saved before
// it existed (and every line a caller doesn't set it on) must still parse unchanged.
describe('TranscriptLineSchema.provisional', () => {
  it('parses a line with no provisional field at all (every pre-existing saved meeting)', () => {
    const parsed = TranscriptLineSchema.safeParse({ speaker: 'them', text: 'Hello', t: 0 })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.provisional).toBeUndefined()
  })

  it('parses a live-only provisional placeholder line', () => {
    const parsed = TranscriptLineSchema.safeParse({ speaker: 'them', text: '…', t: 0, provisional: true })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.provisional).toBe(true)
  })

  it('rejects a non-boolean provisional value', () => {
    expect(TranscriptLineSchema.safeParse({ speaker: 'them', text: 'Hello', t: 0, provisional: 'yes' }).success).toBe(
      false
    )
  })
})

describe('stripProvisionalLines', () => {
  const line = (text: string, t: number, provisional?: true): TranscriptLine => ({
    speaker: 'them',
    text,
    t,
    ...(provisional ? { provisional } : {})
  })

  it('drops every provisional line, keeping the rest in order', () => {
    const lines = [line('Hi', 0), line('…', 1, true), line('Bye', 2)]
    expect(stripProvisionalLines(lines)).toEqual([line('Hi', 0), line('Bye', 2)])
  })

  it('returns the SAME array reference when nothing needed removing (no spurious copy on save)', () => {
    const lines = [line('Hi', 0), line('Bye', 1)]
    expect(stripProvisionalLines(lines)).toBe(lines)
  })

  it('returns an empty array when every line was provisional', () => {
    expect(stripProvisionalLines([line('…', 0, true)])).toEqual([])
  })

  it('is a no-op on an already-empty transcript', () => {
    expect(stripProvisionalLines([])).toEqual([])
  })
})

describe('StreamMetaSchema migration guard', () => {
  it('still parses the current provider-shaped metadata before Task 6', () => {
    const current = { id: 'ask-1', provider: 'anthropic' as const, tier: 'base' as const }
    const parsed = StreamMetaSchema.safeParse(current)
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data).toEqual(current)
  })

  it('still requires a provider and valid provider tier', () => {
    expect(StreamMetaSchema.safeParse({ id: 'ask-1', tier: 'base' }).success).toBe(false)
    expect(StreamMetaSchema.safeParse({ id: 'ask-1', provider: 'anthropic', tier: 'fast' }).success).toBe(false)
  })
})

describe('Mantu Intelligence scan + connect IPC', () => {
  it('names dedicated scan/connect channels (not a silent settings rewrite)', () => {
    expect(IPC.brainScanOneDrive).toBe('brain:scanOneDrive')
    expect(IPC.brainConnect).toBe('brain:connect')
  })

  it('connect payload requires a non-empty path and rejects a blank paste', () => {
    expect(BrainConnectPayloadSchema.safeParse({ path: '/Users/tony/AI Second Brain' }).success).toBe(true)
    expect(BrainConnectPayloadSchema.safeParse({ path: '' }).success).toBe(false)
    expect(BrainConnectPayloadSchema.safeParse({}).success).toBe(false)
  })
})
