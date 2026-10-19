// MQA-296: licence-funded meetings must enter Intelligence without a personal API key.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { PROVIDER_IDS } from '@shared/providers'
import { PORTAL_CF_DEEPSEEK_PRO } from '@shared/ask-routing'
import { clearApiKey, getApiKey, getSettings, setSettings } from '../store'
import type { StreamOptions } from '../llm/shared'
import { brainBackfillProgress, startBackfill } from './ingest'
import { startIntelligencePass } from './intelligence-pass'
import { readIndex } from './store'
import { readSourceText } from './inputs'
import { useStorageForTests } from '../infra/storage/meetings-storage'
import { settleBrainWritesForTests } from '../test-helpers/settle-brain-writes'
import { configureMeetingSpeechLimits, getMeetingSpeechLimits } from '../features/meetings/meeting-speech'
import { TEST_SPEECH_READ_LIMITS, installSpeechReadPolicy } from './__fixtures__/speech-read-policy'

vi.mock('electron')
const hosted = vi.hoisted(() => ({
  providers: vi.fn(() => ['cloudflare']),
  transport: vi.fn<() => { url: string; secret: string } | null>(() => ({
    url: 'https://operator.test',
    secret: 'synthetic-seat-license'
  }))
}))
vi.mock('../operator-ingest', () => ({
  operatorFundedProviders: hosted.providers,
  operatorAskTransport: hosted.transport
}))
const localReady = vi.hoisted(() => vi.fn(() => false))
vi.mock('../llm/local-routing', () => ({
  localBaseReady: localReady,
  resolveRoutingMode: (s: { routingMode?: string }) => s.routingMode ?? 'auto'
}))
const createStream = vi.hoisted(() =>
  vi.fn((opts: StreamOptions) => {
    queueMicrotask(() => {
      opts.handlers.onDelta('{}')
      opts.handlers.onDone({})
    })
    return { abort: () => {} }
  })
)
vi.mock('../llm', () => ({ createStream }))

describe('license-funded meeting extraction', () => {
  let profile: string
  let meetings: string
  let restoreSpeechReadPolicy = (): void => {}

  beforeEach(() => {
    restoreSpeechReadPolicy = installSpeechReadPolicy()
    useStorageForTests()
    profile = mkdtempSync(join(tmpdir(), 'metis-funded-brain-'))
    meetings = join(profile, 'meetings')
    mkdirSync(meetings)
    vi.mocked(app.getPath).mockImplementation((name) => (name === 'userData' ? profile : join(profile, name)))
    for (const key of Object.keys(process.env)) if (key.endsWith('_API_KEY')) vi.stubEnv(key, undefined)
    for (const provider of PROVIDER_IDS) clearApiKey(provider)
    setSettings({ meetingsFolder: meetings, provider: 'cloudflare', redactSensitive: false })
    hosted.providers.mockReturnValue(['cloudflare'])
    hosted.transport.mockReturnValue({ url: 'https://operator.test', secret: 'synthetic-seat-license' })
    localReady.mockReturnValue(false)
    createStream.mockClear()
  })

  afterEach(async () => {
    try {
      await settleBrainWritesForTests()
    } finally {
      try {
        rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      } finally {
        try {
          vi.unstubAllEnvs()
        } finally {
          restoreSpeechReadPolicy()
        }
      }
    }
  })

  async function settle(): Promise<void> {
    await vi.waitFor(() => expect(brainBackfillProgress().running).toBe(false), { timeout: 10_000 })
    await settleBrainWritesForTests()
  }

  function meeting(): void {
    writeFileSync(
      join(meetings, 'funded.md'),
      '---\ndate: 2026-09-01\n---\nSynthetic team agreed to send a project checklist tomorrow.\n'
    )
  }

  it('fails closed when the trusted speech-read budget is absent and makes no provider call', async () => {
    meeting()
    configureMeetingSpeechLimits(undefined)

    expect(getMeetingSpeechLimits()).toBeUndefined()
    const source = await readSourceText(join(meetings, 'funded.md'))
    expect(source.status).toBe('unreadable')
    if (source.status !== 'unreadable') throw new Error('Expected the source read to fail closed.')
    if (!(source.error instanceof Error)) throw new Error('Expected the source read to expose an Error.')
    expect(source.error.message).toBe('Meeting read limit is unavailable.')

    expect(await startBackfill()).toEqual({ queued: 1 })
    await settle()
    expect(createStream).not.toHaveBeenCalled()
  })

  it('refuses a source over the configured byte limit without a provider call', async () => {
    meeting()
    configureMeetingSpeechLimits({ ...TEST_SPEECH_READ_LIMITS, maxPayloadBytes: 1 })

    const source = await readSourceText(join(meetings, 'funded.md'))
    expect(source.status).toBe('unreadable')
    if (source.status !== 'unreadable') throw new Error('Expected the oversized source read to fail closed.')
    if (!(source.error instanceof Error)) throw new Error('Expected the oversized read to expose an Error.')
    expect(source.error.message).toBe('SIZE_LIMIT')

    expect(await startBackfill()).toEqual({ queued: 1 })
    await settle()
    expect(createStream).not.toHaveBeenCalled()
  })

  it('restores an absent prior speech-read policy', () => {
    configureMeetingSpeechLimits(undefined)
    const restore = installSpeechReadPolicy()

    try {
      expect(getMeetingSpeechLimits()).toEqual(TEST_SPEECH_READ_LIMITS)
    } finally {
      restore()
    }

    expect(getMeetingSpeechLimits()).toBeUndefined()
  })

  it('restores an explicitly configured prior speech-read policy', () => {
    const previous = { ...TEST_SPEECH_READ_LIMITS, maxPayloadBytes: 900000 }
    configureMeetingSpeechLimits(previous)
    const restore = installSpeechReadPolicy()

    try {
      expect(getMeetingSpeechLimits()).toEqual(TEST_SPEECH_READ_LIMITS)
    } finally {
      restore()
    }

    expect(getMeetingSpeechLimits()).toEqual(previous)
  })

  it.each([
    'backfill',
    'intelligence pass'
  ] as const)('indexes through %s with a license and no device API key or Cloudflare endpoint', async (path) => {
    meeting()
    const result = path === 'backfill' ? await startBackfill() : await startIntelligencePass()
    expect(result).toEqual({ queued: 1 })
    await settle()
    expect(readIndex(getSettings()).ingested['funded.md']?.ok).toBe(true)
    expect(createStream).toHaveBeenCalledTimes(1)
    expect(createStream.mock.calls[0][0]).toMatchObject({
      providerId: 'cloudflare',
      apiKey: '',
      viaOperator: true,
      operatorTransport: { url: 'https://operator.test', secret: 'synthetic-seat-license' },
      model: PORTAL_CF_DEEPSEEK_PRO
    })
    expect(getApiKey('cloudflare')).toBe('')
  })

  it('does not use an advertised provider when license transport is unavailable', async () => {
    hosted.transport.mockReturnValue(null)
    meeting()
    expect(await startBackfill()).toEqual({ queued: 0, deferred: 'no-provider' })
    expect(createStream).not.toHaveBeenCalled()
  })

  it('does not let a funded provider bypass the organization allowlist', async () => {
    writeFileSync(join(profile, 'managed-config.json'), JSON.stringify({ allowedProviders: ['local'] }))
    meeting()
    expect(await startBackfill()).toEqual({ queued: 0, deferred: 'no-provider' })
    expect(createStream).not.toHaveBeenCalled()
  })

  it('keeps explicit on-device summaries private when the local runtime is unavailable', async () => {
    setSettings({
      localLlm: { ...getSettings().localLlm, enabled: true, useFor: { suggest: false, summary: true, vision: false } }
    })
    meeting()
    expect(await startBackfill()).toEqual({ queued: 0, deferred: 'no-provider' })
    expect(createStream).not.toHaveBeenCalled()
  })

  it('explains the local-only policy when an Intelligence click cannot use the available license', async () => {
    setSettings({ routingMode: 'local' })
    meeting()
    const result = await startIntelligencePass()
    expect(result.queued).toBe(0)
    expect(result.error).toMatch(/local.only.*not ready/i)
    expect(createStream).not.toHaveBeenCalled()
  })
})
