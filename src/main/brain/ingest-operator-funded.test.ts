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
import { brainBackfillProgress, startBackfill, whenIndexWritesSettle } from './ingest'
import { startIntelligencePass } from './intelligence-pass'
import { readIndex } from './store'

vi.mock('electron')
const hosted = vi.hoisted(() => ({
  providers: vi.fn(() => ['cloudflare']),
  transport: vi.fn<() => { url: string; secret: string } | null>(() => ({
    url: 'https://operator.test', secret: 'synthetic-seat-license'
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
const createStream = vi.hoisted(() => vi.fn((opts: StreamOptions) => {
  queueMicrotask(() => {
    opts.handlers.onDelta('{}')
    opts.handlers.onDone({})
  })
  return { abort: () => {} }
}))
vi.mock('../llm', () => ({ createStream }))

describe('license-funded meeting extraction', () => {
  let profile: string
  let meetings: string

  beforeEach(() => {
    profile = mkdtempSync(join(tmpdir(), 'metis-funded-brain-'))
    meetings = join(profile, 'meetings')
    mkdirSync(meetings)
    vi.mocked(app.getPath).mockImplementation((name) => name === 'userData' ? profile : join(profile, name))
    for (const key of Object.keys(process.env)) if (key.endsWith('_API_KEY')) vi.stubEnv(key, undefined)
    for (const provider of PROVIDER_IDS) clearApiKey(provider)
    setSettings({ meetingsFolder: meetings, provider: 'cloudflare', redactSensitive: false })
    hosted.providers.mockReturnValue(['cloudflare'])
    hosted.transport.mockReturnValue({ url: 'https://operator.test', secret: 'synthetic-seat-license' })
    localReady.mockReturnValue(false)
    createStream.mockClear()
  })

  afterEach(async () => {
    await whenIndexWritesSettle()
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    vi.unstubAllEnvs()
  })

  async function settle(): Promise<void> {
    await vi.waitFor(() => expect(brainBackfillProgress().running).toBe(false), { timeout: 10_000 })
    await whenIndexWritesSettle()
  }

  function meeting(): void {
    writeFileSync(join(meetings, 'funded.md'), '---\ndate: 2026-09-01\n---\nSynthetic team agreed to send a project checklist tomorrow.\n')
  }

  it.each(['backfill', 'intelligence pass'] as const)('indexes through %s with a license and no device API key or Cloudflare endpoint', async (path) => {
    meeting()
    const result = path === 'backfill' ? startBackfill() : startIntelligencePass()
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

  it('does not use an advertised provider when license transport is unavailable', () => {
    hosted.transport.mockReturnValue(null)
    meeting()
    expect(startBackfill()).toEqual({ queued: 0, deferred: 'no-provider' })
    expect(createStream).not.toHaveBeenCalled()
  })

  it('does not let a funded provider bypass the organization allowlist', () => {
    writeFileSync(join(profile, 'managed-config.json'), JSON.stringify({ allowedProviders: ['local'] }))
    meeting()
    expect(startBackfill()).toEqual({ queued: 0, deferred: 'no-provider' })
    expect(createStream).not.toHaveBeenCalled()
  })

  it('keeps explicit on-device summaries private when the local runtime is unavailable', () => {
    setSettings({ localLlm: { ...getSettings().localLlm, enabled: true, useFor: { suggest: false, summary: true, vision: false } } })
    meeting()
    expect(startBackfill()).toEqual({ queued: 0, deferred: 'no-provider' })
    expect(createStream).not.toHaveBeenCalled()
  })

  it('explains the local-only policy when an Intelligence click cannot use the available license', () => {
    setSettings({ routingMode: 'local' })
    meeting()
    const result = startIntelligencePass()
    expect(result.queued).toBe(0)
    expect(result.error).toMatch(/local.only.*not ready/i)
    expect(createStream).not.toHaveBeenCalled()
  })
})
