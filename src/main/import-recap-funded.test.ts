import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type Settings, type TranscriptLine } from '@shared/ipc'
import { PORTAL_CF_DEEPSEEK_FLASH } from '@shared/ask-routing'
import { redactSecrets } from '@shared/redact'
import type { StreamOptions } from './llm/shared'
import { pickImportRecapCandidates, runImportedRecap } from './import-recap'

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
  const lines: TranscriptLine[] = [{ name: 'Speaker 1', speaker: 'unknown', t: 0, text: 'Send the checklist tomorrow.' }]

  beforeEach(() => localReady.mockReturnValue(false))

  it('accepts license-funded AI without a device API key or a direct provider endpoint', () => {
    expect(pickImportRecapCandidates(settings(), gate)).toEqual(['cloudflare'])
    expect(pickImportRecapCandidates(settings(), { ...gate, operatorAskTransport: () => null })).toEqual([])
    expect(pickImportRecapCandidates(settings(), { ...gate, getAllowedProviders: () => ['local'] })).toEqual([])
  })

  it('redacts secrets before licensed cloud summary generation while preserving the original transcript', async () => {
    const secret = 'sk-synthetic-example-credential-abcdefghijklmnop'
    const sourceLines = [{ ...lines[0], text: `Send the checklist tomorrow. Test token ${secret}.` }]
    const createStream = vi.fn((opts: StreamOptions) => {
      opts.handlers.onDelta('## Action items\n- Send the checklist tomorrow.')
      opts.handlers.onDone({})
      return { abort: () => {} }
    })
    const recap = await runImportedRecap({ jobId: 'funded', mode: 'meeting', lines: sourceLines }, {
      ...gate, getSettings: () => settings(), redactSecrets, createStream
    })
    expect(recap).toContain('Send the checklist tomorrow.')
    expect(createStream).toHaveBeenCalledTimes(1)
    const sent = createStream.mock.calls[0][0]
    expect(sent).toMatchObject({ providerId: 'cloudflare', apiKey: '', viaOperator: true, operatorTransport: transport, model: PORTAL_CF_DEEPSEEK_FLASH })
    expect(sent.req.transcript).toContain('[redacted key]')
    expect(JSON.stringify(sent.req)).not.toContain(secret)
    expect(sourceLines[0].text).toContain(secret)
  })

  it.each(['routing', 'summary toggle'] as const)('honors explicit local-only %s even when the local runtime is unavailable', async (choice) => {
    const s = settings(choice === 'routing'
      ? { routingMode: 'local' }
      : { localLlm: { ...DEFAULT_SETTINGS.localLlm, enabled: true, useFor: { suggest: false, summary: true, vision: false } } })
    const createStream = vi.fn()
    expect(pickImportRecapCandidates(s, gate)).toEqual([])
    await expect(runImportedRecap({ jobId: 'private', mode: 'meeting', lines }, {
      ...gate, getSettings: () => s, redactSecrets, createStream
    })).rejects.toThrow(/local.only.*not ready/i)
    expect(createStream).not.toHaveBeenCalled()
  })

  it('does not fall through to funded cloud when an opted-in local summary fails', async () => {
    localReady.mockReturnValue(true)
    const s = settings({ localLlm: { ...DEFAULT_SETTINGS.localLlm, enabled: true, useFor: { suggest: false, summary: true, vision: false } } })
    const createStream = vi.fn((opts: StreamOptions) => {
      opts.handlers.onError('Local runtime unavailable')
      return { abort: () => {} }
    })
    await expect(runImportedRecap({ jobId: 'local-failure', mode: 'meeting', lines }, {
      ...gate, getSettings: () => s, redactSecrets, createStream
    })).rejects.toThrow(/Local runtime unavailable/)
    expect(createStream.mock.calls.map(([opts]) => opts.providerId)).toEqual(['local'])
  })
})
