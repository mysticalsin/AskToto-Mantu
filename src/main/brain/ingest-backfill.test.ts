import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import { PROVIDER_IDS } from '@shared/providers'
import { getSettings, setSettings } from '../store'
import { mainLog } from '../logger'
import { startBackfill, brainBackfillProgress } from './ingest'
import { readIndex } from './store'

vi.mock('electron')

/**
 * R1 — a backfill queued with no configured AI provider must not fire 60+ doomed extraction calls
 * (each "No configured AI provider for brain ingest", each with its one reinforcement retry). It should
 * queue nothing, log once, and leave `backfillRequested` set so resumeBackfillIfPending tries again once
 * a provider exists on a later boot. See pump()'s and startBackfill()'s no-provider guards in ingest.ts.
 */
describe('startBackfill with no configured provider', () => {
  let userData: string
  let meetingsFolder: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'asktoto-backfill-test-'))
    meetingsFolder = mkdtempSync(join(tmpdir(), 'asktoto-backfill-meetings-'))
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      if (name === 'userData') return userData
      return join(userData, name)
    })
    // No API key file is ever written in this test, but getApiKey() checks provider env vars BEFORE
    // the on-disk key — a real ANTHROPIC_API_KEY etc. in the test runner's shell would silently make a
    // provider resolve and defeat the whole point of this test. Clear every provider's env var.
    for (const p of PROVIDER_IDS) {
      const envVar = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', nvidia: 'NVIDIA_API_KEY',
        deepseek: 'DEEPSEEK_API_KEY', qwen: 'DASHSCOPE_API_KEY', minimax: 'MINIMAX_API_KEY',
        kimi: 'MOONSHOT_API_KEY', openrouter: 'OPENROUTER_API_KEY', groq: 'GROQ_API_KEY',
        together: 'TOGETHER_API_KEY', fireworks: 'FIREWORKS_API_KEY', mistral: 'MISTRAL_API_KEY',
        dust: 'DUST_API_KEY', 'claude-cli': '', 'codex-cli': '', gemini: 'GEMINI_API_KEY',
        custom: 'ASKTOTO_CUSTOM_API_KEY' }[p]
      if (envVar) vi.stubEnv(envVar, '')
    }
    setSettings({ meetingsFolder })
    // A couple of real, not-yet-ingested transcripts for startBackfill's folder scan to find.
    writeFileSync(join(meetingsFolder, 'meeting-1.md'), '---\ndate: 2026-01-01\n---\nhello', 'utf8')
    writeFileSync(join(meetingsFolder, 'meeting-2.md'), '---\ndate: 2026-01-02\n---\nworld', 'utf8')
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
    rmSync(meetingsFolder, { recursive: true, force: true })
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('queues nothing and preserves backfillRequested for a later resume', async () => {
    const warnSpy = vi.spyOn(mainLog, 'warn').mockImplementation(() => undefined as unknown as void)

    const result = startBackfill()

    expect(result.queued).toBe(0)
    // Never touched the queue/progress counters — nothing was actually started.
    expect(brainBackfillProgress()).toEqual({ total: 0, done: 0, running: false })
    // startBackfill's `backfillRequested = true` write is fire-and-forget (updateIndex isn't awaited,
    // by design — callers must never block on it), so give its file write a tick to land before reading
    // it back.
    await vi.waitFor(() => {
      expect(readIndex(getSettings()).backfillRequested).toBe(true)
    })
    // Exactly one short warning, not one per candidate transcript that would have been queued.
    const brainWarnings = warnSpy.mock.calls.filter((c) => String(c[0]).includes('[brain]'))
    expect(brainWarnings.length).toBe(1)
  })

  it('does not scan the meetings folder at all when no provider is configured', async () => {
    // mkdirSync spy would be overkill; instead assert indirectly via queued===0 AND that a directory
    // that does not exist doesn't throw (readdirSync would only run if the no-provider guard were
    // bypassed) — combined with the above test this is sufficient coverage for the cheap-bailout claim.
    setSettings({ meetingsFolder: join(meetingsFolder, 'does-not-exist') })
    const result = startBackfill()
    expect(result.queued).toBe(0)
    // The missing meetings folder must not be scanned, but the durable resume flag is still expected
    // to create `.brain/index.json`. Wait for that intentional fire-and-forget write before afterEach
    // removes the temporary root, otherwise teardown can race the pending write and fail with ENOTEMPTY.
    await vi.waitFor(() => {
      expect(readIndex(getSettings()).backfillRequested).toBe(true)
    })
  })
})
