import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type Settings, type TranscriptLine } from '@shared/ipc'
import { PORTAL_CF_DEEPSEEK_FLASH } from '@shared/ask-routing'
import { PROVIDERS, type ProviderId } from '@shared/providers'
import { redactSecrets } from '@shared/redact'
import type { StreamOptions } from './llm/shared'
import { IMPORT_RECAP_SYSTEM_PREFIX, pickImportRecapCandidates, runImportedRecap } from './import-recap'
import { ImportJobManager } from './import-jobs'

const localReady = vi.hoisted(() => vi.fn(() => false))
vi.mock('./llm/local-routing', () => ({
  localPrimaryEligibleFor: localReady,
  localFallbackEligibleFor: () => false,
  resolveRoutingMode: (s: Settings) => s.routingMode ?? 'auto'
}))

describe('MQA-297 automatic summaries with a Métis license', () => {
  const transport = { url: 'https://operator.test', secret: 'synthetic-seat-license' }
  const gate = {
    getApiKey: () => '',
    providerBaseUrl: () => '',
    getAllowedProviders: (): string[] | null => null,
    operatorFundedProviders: () => ['cloudflare'],
    operatorAskTransport: () => transport
  }
  const settings = (patch: Partial<Settings> = {}): Settings => ({
    ...DEFAULT_SETTINGS,
    provider: 'cloudflare',
    ...patch
  })
  const lines: TranscriptLine[] = [
    { name: 'Speaker 1', speaker: 'unknown', t: 0, text: 'Send the checklist tomorrow.' }
  ]

  beforeEach(() => localReady.mockReturnValue(false))

  it('accepts license-funded AI without a device API key or a direct provider endpoint', () => {
    expect(pickImportRecapCandidates(settings(), gate)).toEqual(['cloudflare'])
    expect(pickImportRecapCandidates(settings(), { ...gate, operatorAskTransport: () => null })).toEqual([])
    expect(pickImportRecapCandidates(settings(), { ...gate, getAllowedProviders: () => ['local'] })).toEqual([])
  })

  it.each([
    { label: 'funded transport', key: '', funded: true, connected: true, endpoint: '', route: 'managed' },
    { label: 'transport without funding', key: '', funded: false, connected: true, endpoint: '', route: 'refused' },
    { label: 'funding without transport', key: '', funded: true, connected: false, endpoint: '', route: 'refused' },
    { label: 'BYOK without endpoint', key: 'synthetic-key', funded: false, connected: false, endpoint: '', route: 'refused' },
    { label: 'funded BYOK without endpoint', key: 'synthetic-key', funded: true, connected: true, endpoint: '', route: 'refused' },
    { label: 'funded BYOK with endpoint', key: 'synthetic-key', funded: true, connected: true, endpoint: 'https://worker.example.test/v1', route: 'direct' }
  ])('MQA-215 routes the real import recap for $label without unintended stream work', async ({ key, funded, connected, endpoint, route }) => {
    const s = settings({ cloudflareBaseUrl: endpoint, redactSensitive: true })
    const providerBaseUrl = vi.fn(() => endpoint)
    const candidateGate = {
      getApiKey: (provider: ProviderId) => provider === 'cloudflare' ? key : '',
      providerBaseUrl,
      getAllowedProviders: () => ['cloudflare'],
      operatorFundedProviders: () => funded ? ['cloudflare'] : [],
      operatorAskTransport: () => connected ? transport : null
    }
    const createStream = vi.fn((opts: StreamOptions) => {
      opts.handlers.onDelta('## Overview\nSynthetic routed recap.')
      opts.handlers.onDone({})
      return { abort: () => {} }
    })
    const redact = vi.fn((text: string) => text)
    expect(pickImportRecapCandidates(s, candidateGate)).toEqual(route === 'refused' ? [] : ['cloudflare'])
    const recap = await runImportedRecap(
      { jobId: 'endpoint-gate', mode: 'meeting', lines },
      { ...candidateGate, getSettings: () => s, redactSecrets: redact, createStream }
    )
    if (route === 'refused') {
      expect(recap).toBeUndefined()
      expect(createStream).not.toHaveBeenCalled()
      expect(redact).not.toHaveBeenCalled()
      return
    }
    expect(recap).toBe('## Overview\nSynthetic routed recap.')
    expect(createStream).toHaveBeenCalledOnce()
    expect(redact).toHaveBeenCalledOnce()
    expect(createStream.mock.calls[0][0]).toMatchObject({
      providerId: 'cloudflare',
      apiKey: route === 'managed' ? '' : key,
      viaOperator: route === 'managed',
      operatorTransport: route === 'managed' ? transport : undefined,
      baseURL: route === 'direct' ? endpoint : undefined
    })
    if (route === 'managed') expect(providerBaseUrl).not.toHaveBeenCalled()
  })

  it.each(['success', 'failure'] as const)(
    'MQA-215 excludes an endpointless BYOK candidate from the three real attempts and preserves last eligible %s',
    async (outcome) => {
      const eligible: ProviderId[] = ['anthropic', 'openai', 'deepseek']
      const s = settings({
        provider: 'cloudflare',
        cloudflareBaseUrl: '',
        providerModels: {
          ...DEFAULT_SETTINGS.providerModels,
          anthropic: PROVIDERS.anthropic.defaultModel,
          openai: PROVIDERS.openai.defaultModel,
          deepseek: PROVIDERS.deepseek.defaultModel
        }
      })
      const candidateGate = {
        getApiKey: (provider: ProviderId) => [...eligible, 'cloudflare'].includes(provider) ? 'synthetic-key' : '',
        providerBaseUrl: () => '',
        getAllowedProviders: () => [...eligible, 'cloudflare'],
        operatorFundedProviders: () => ['cloudflare'],
        operatorAskTransport: () => transport
      }
      const createStream = vi.fn((opts: StreamOptions) => {
        if (opts.providerId === 'deepseek' && outcome === 'success') {
          opts.handlers.onDelta('## Overview\nThird eligible provider completed.')
          opts.handlers.onDone({})
        } else {
          opts.handlers.onError(`synthetic ${opts.providerId} cause`)
        }
        return { abort: () => {} }
      })
      expect(pickImportRecapCandidates(s, candidateGate)).toEqual(eligible)
      const recap = runImportedRecap(
        { jobId: 'endpoint-attempts', mode: 'meeting', lines },
        { ...candidateGate, getSettings: () => s, redactSecrets, createStream }
      )
      if (outcome === 'success') {
        await expect(recap).resolves.toBe('## Overview\nThird eligible provider completed.')
      } else {
        await expect(recap).rejects.toThrow('Summary provider failed before completion (synthetic deepseek cause). Please retry.')
      }
      expect(createStream.mock.calls.map(([opts]) => opts.providerId)).toEqual(eligible)
      expect(createStream).toHaveBeenCalledTimes(3)
      for (const [sent] of createStream.mock.calls) {
        expect(sent.viaOperator).toBe(false)
        expect(sent.operatorTransport).toBeUndefined()
        expect(sent.apiKey).toBe('synthetic-key')
      }
    }
  )

  it('redacts secrets before licensed cloud summary generation while preserving the original transcript', async () => {
    const secret = 'sk-synthetic-example-credential-abcdefghijklmnop'
    const sourceLines = [{ ...lines[0], text: `Send the checklist tomorrow. Test token ${secret}.` }]
    const createStream = vi.fn((opts: StreamOptions) => {
      opts.handlers.onDelta('## Action items\n- Send the checklist tomorrow.')
      opts.handlers.onDone({})
      return { abort: () => {} }
    })
    const recap = await runImportedRecap(
      { jobId: 'funded', mode: 'meeting', lines: sourceLines },
      {
        ...gate,
        getSettings: () => settings(),
        redactSecrets,
        createStream
      }
    )
    expect(recap).toContain('Send the checklist tomorrow.')
    expect(createStream).toHaveBeenCalledTimes(1)
    const sent = createStream.mock.calls[0][0]
    expect(sent).toMatchObject({
      providerId: 'cloudflare',
      apiKey: '',
      viaOperator: true,
      operatorTransport: transport,
      model: PORTAL_CF_DEEPSEEK_FLASH
    })
    expect(sent.req.transcript).toContain('[redacted key]')
    expect(JSON.stringify(sent.req)).not.toContain(secret)
    expect(sourceLines[0].text).toContain(secret)
  })

  it.each([
    'routing',
    'summary toggle'
  ] as const)('honors explicit local-only %s even when the local runtime is unavailable', async (choice) => {
    const s = settings(
      choice === 'routing'
        ? { routingMode: 'local' }
        : {
            localLlm: {
              ...DEFAULT_SETTINGS.localLlm,
              enabled: true,
              useFor: { suggest: false, summary: true, vision: false }
            }
          }
    )
    const createStream = vi.fn()
    expect(pickImportRecapCandidates(s, gate)).toEqual([])
    await expect(
      runImportedRecap(
        { jobId: 'private', mode: 'meeting', lines },
        {
          ...gate,
          getSettings: () => s,
          redactSecrets,
          createStream
        }
      )
    ).rejects.toThrow(/local.only.*not ready/i)
    expect(createStream).not.toHaveBeenCalled()
  })

  it('does not fall through to funded cloud when an opted-in local summary fails', async () => {
    localReady.mockReturnValue(true)
    const s = settings({
      localLlm: {
        ...DEFAULT_SETTINGS.localLlm,
        enabled: true,
        useFor: { suggest: false, summary: true, vision: false }
      }
    })
    const createStream = vi.fn((opts: StreamOptions) => {
      opts.handlers.onError('Local runtime unavailable')
      return { abort: () => {} }
    })
    await expect(
      runImportedRecap(
        { jobId: 'local-failure', mode: 'meeting', lines },
        {
          ...gate,
          getSettings: () => s,
          redactSecrets,
          createStream
        }
      )
    ).rejects.toThrow(/Local runtime unavailable/)
    expect(createStream.mock.calls.map(([opts]) => opts.providerId)).toEqual(['local'])
  })

  it.each([
    'missing metadata',
    'missing sections',
    'template echo'
  ] as const)('MQA-327 rejects local %s without falling through to configured licensed cloud', async (failure) => {
    localReady.mockReturnValue(true)
    const s = settings({ routingMode: 'local' })
    const valid = [...IMPORT_RECAP_SYSTEM_PREFIX.matchAll(/^## ([^:]+):/gm)]
      .map((match) => `## ${match[1]}\nA synthetic note.`)
      .join('\n')
    const output =
      failure === 'missing sections'
        ? '## Overview\nAn incomplete document.'
        : failure === 'template echo'
          ? IMPORT_RECAP_SYSTEM_PREFIX
          : valid
    const createStream = vi.fn((opts: StreamOptions) => {
      opts.handlers.onDelta(output)
      opts.handlers.onDone({}, failure === 'missing metadata' ? undefined : { status: 'complete', reason: 'stop' })
      return { abort: () => {} }
    })
    await expect(
      runImportedRecap(
        { jobId: 'malformed-local', mode: 'meeting', lines },
        {
          ...gate,
          getSettings: () => s,
          redactSecrets,
          createStream
        }
      )
    ).rejects.toThrow(/local ai.*complete.*structured.*retry/i)
    expect(createStream.mock.calls.map(([opts]) => opts.providerId)).toEqual(['local'])
  })

  it('MQA-327 accepts a complete structured local result without changing its text', async () => {
    localReady.mockReturnValue(true)
    const output = [...IMPORT_RECAP_SYSTEM_PREFIX.matchAll(/^## ([^:]+):/gm)]
      .map((match) => `## ${match[1]}\nA synthetic note.`)
      .join('\n')
    const createStream = vi.fn((opts: StreamOptions) => {
      opts.handlers.onDelta(output)
      opts.handlers.onDone({}, { status: 'complete', reason: 'stop' })
      return { abort: () => {} }
    })
    await expect(
      runImportedRecap(
        { jobId: 'complete-local', mode: 'meeting', lines },
        {
          ...gate,
          getSettings: () => settings({ routingMode: 'local' }),
          redactSecrets,
          createStream
        }
      )
    ).resolves.toBe(output)
    expect(createStream.mock.calls.map(([opts]) => opts.providerId)).toEqual(['local'])
  })

  it('MQA-327 preserves and indexes the transcript without saving or crediting a malformed local recap', async () => {
    localReady.mockReturnValue(true)
    const createStream = vi.fn((opts: StreamOptions) => {
      opts.handlers.onDelta('A normally stopped but unrelated response.')
      opts.handlers.onDone({}, { status: 'complete', reason: 'stop' })
      return { abort: () => {} }
    })
    const saveMeeting = vi.fn(async () => 'synthetic-import.md')
    const updateRecap = vi.fn(async () => {})
    const recordMeetingSummarized = vi.fn()
    const enqueueIngest = vi.fn()
    const manager = new ImportJobManager({
      store: { save: async () => {}, list: async () => [], remove: async () => {} },
      decode: () => {},
      transcribe: async () => lines[0].text,
      saveMeeting,
      updateRecap,
      recordMeetingSummarized,
      enqueueIngest,
      generateRecap: (job) =>
        runImportedRecap(job, {
          ...gate,
          getSettings: () => settings({ routingMode: 'local' }),
          redactSecrets,
          createStream
        }),
      now: () => 1_700_000_000_000,
      newId: () => 'contained-local'
    })
    // Real speech-shaped VAD input; the ASR adapter is synthetic, but finalization/persistence routing
    // and local provider completion handling are production implementations.
    const pcm = new Float32Array(25_600)
    for (let i = 0; i < 9_600; i++) pcm[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / 16_000)
    await manager.start({ path: '/synthetic.wav', name: 'synthetic.wav', sizeBytes: 42, mtimeMs: 1 })
    await manager.acceptDecodedChunk('contained-local', 0, 0, pcm)
    await manager.finishDecoding('contained-local')
    expect(saveMeeting).toHaveBeenCalledOnce()
    expect(saveMeeting).toHaveBeenCalledWith(
      expect.objectContaining({ recap: '', lines: [expect.objectContaining({ text: lines[0].text })] }),
      expect.any(Function)
    )
    expect(manager.get('contained-local')).toMatchObject({
      state: 'done',
      file: 'synthetic-import.md',
      recapError: expect.stringMatching(/local ai.*structured/i)
    })
    expect(manager.get('contained-local')?.recapError).not.toMatch(/transcript saved/i)
    expect(updateRecap).not.toHaveBeenCalled()
    expect(recordMeetingSummarized).not.toHaveBeenCalled()
    expect(enqueueIngest).toHaveBeenCalledWith('synthetic-import.md', undefined, expect.any(Function))
    expect(createStream.mock.calls.map(([opts]) => opts.providerId)).toEqual(['local'])
  })
})
