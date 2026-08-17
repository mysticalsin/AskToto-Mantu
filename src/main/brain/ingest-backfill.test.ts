import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import { PROVIDER_IDS } from '@shared/providers'
import { MeetingExtractionSchema } from '@shared/brain'
import { getSettings, setSettings } from '../store'
import { mainLog } from '../logger'
import { startBackfill, brainBackfillProgress, reconcileMeetingsInBackground, whenIndexWritesSettle } from './ingest'
import { readAccount, readDeal, readIndex, slugify, writeIndex, writeMeetingExtraction } from './store'

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

  /** Module is fully quiet: queue drained, no deferred scan pending, and every index write landed. */
  const waitForBrainIdle = async (): Promise<void> => {
    await vi.waitFor(
      () => {
        const p = brainBackfillProgress()
        expect(p.running).toBe(false)
        expect(p.preparing).toBeFalsy()
      },
      { timeout: 15_000 }
    )
    await whenIndexWritesSettle()
  }

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
      const envVar = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', grok: 'XAI_API_KEY', nvidia: 'NVIDIA_API_KEY',
        deepseek: 'DEEPSEEK_API_KEY', qwen: 'DASHSCOPE_API_KEY', minimax: 'MINIMAX_API_KEY',
        kimi: 'KIMI_API_KEY', openrouter: 'OPENROUTER_API_KEY', groq: 'GROQ_API_KEY',
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

  afterEach(async () => {
    // Drain before teardown, don't just retry around it. These flags are MODULE-level, so leftover work
    // does not merely race rmSync — it changes the NEXT test's behaviour: reconcileMeetingsInBackground()
    // opens with `if (backfillPreparing || sourceRefreshRunning || hasActiveBackfill()) return`, so a
    // still-active backfill from the previous test makes the next one's reconcile a silent no-op and its
    // waitFor times out with nothing to show. That was the ~1-in-4 full-suite flake.
    // `preparing` matters as much as `running`: requestBackfill() returns {queued:0, preparing:true} and
    // finishes its scan on a later turn, so running===false alone does not mean the module is idle.
    await waitForBrainIdle()
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    rmSync(meetingsFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('queues nothing and preserves backfillRequested for a later resume', async () => {
    const warnSpy = vi.spyOn(mainLog, 'warn').mockImplementation(() => undefined as unknown as void)

    const result = startBackfill()

    expect(result).toEqual({ queued: 0, deferred: 'no-provider' })
    // Never touched the queue/progress counters — nothing was actually started.
    expect(brainBackfillProgress()).toEqual({ total: 0, done: 0, running: false })
    // startBackfill's `backfillRequested = true` write is fire-and-forget (updateIndex isn't awaited,
    // by design — callers must never block on it), so give its file write a tick to land before reading
    // it back.
    await vi.waitFor(() => {
      expect(readIndex(getSettings()).backfillRequested).toBe(true)
    }, { timeout: 10_000 })
    // Exactly one short warning, not one per candidate transcript that would have been queued.
    const brainWarnings = warnSpy.mock.calls.filter((c) => String(c[0]).includes('[brain]'))
    expect(brainWarnings.length).toBe(1)
  })

  it('handles an unavailable meetings folder without queueing model work', () => {
    // OneDrive may temporarily make a configured folder unavailable. The scan must remain safe and
    // must not manufacture provider-backed jobs while the source is unavailable.
    setSettings({ meetingsFolder: join(meetingsFolder, 'does-not-exist') })
    const result = startBackfill()
    expect(result.queued).toBe(0)
  })

  it('repairs a saved extraction without a provider because it does not need another model call', async () => {
    const file = 'partial-merge.md'
    writeFileSync(
      join(meetingsFolder, file),
      '---\ndate: 2026-01-03\n---\nThe confirmed EUR 240000 budget will close on 2026-09-30.',
      'utf8'
    )
    await writeMeetingExtraction(
      getSettings(),
      slugify(file),
      MeetingExtractionSchema.parse({
        title24: 'Recover partial merge',
        account: { name: 'Recovered Account', sector: 'technology', confidence: 'EXTRACTED' },
        deal: {
          name: 'Recovered renewal',
          stage: 'proposal',
          win_likelihood_band: 'good',
          band_evidence: 'confirmed EUR 240000 budget',
          velocity: { signal: 'hard-calendar-gate', evidence: 'close on 2026-09-30' },
          amount: { value: 240000, currency: 'EUR', quote: 'EUR 240000 budget' },
          close_date: { value: '2026-09-30', quote: 'close on 2026-09-30' }
        }
      })
    )

    // A missing API key must defer only work that needs a new extraction. This checkpoint can be merged
    // locally and is the exact recovery path after a keychain/profile interruption.
    // The two baseline sources still need first-pass extraction, so the result makes that deferral
    // explicit while allowing this saved extraction to proceed locally now.
    expect(startBackfill()).toEqual({ queued: 1, deferred: 'no-provider' })
    await vi.waitFor(() => {
      expect(readIndex(getSettings()).ingested[file]?.ok).toBe(true)
    }, { timeout: 10_000 })
    expect(readAccount(getSettings(), slugify('Recovered Account'))?.meetings.map((m) => m.file)).toContain(file)
    expect(readIndex(getSettings()).backfillRequested).toBe(true)
    const deal = readDeal(getSettings(), slugify('Recovered renewal'))
    expect(deal?.amount?.state).toBe('verified')
    expect(deal?.amount?.confidence).toBe('EXTRACTED')
    expect(deal?.close_date?.state).toBe('verified')
    expect(deal?.win_likelihood_band_provenance?.confidence).toBe('EXTRACTED')
  })

  it('repairs a saved extraction from the background reconciliation loop without a provider', async () => {
    const file = 'background-repair.md'
    writeFileSync(join(meetingsFolder, file), '---\ndate: 2026-01-04\n---\nBackground repair is local.', 'utf8')
    await writeMeetingExtraction(
      getSettings(),
      slugify(file),
      MeetingExtractionSchema.parse({ title24: 'Background checkpoint repair' })
    )

    reconcileMeetingsInBackground()

    // Explicit timeout: this is the only assertion here waiting on the BACKGROUND reconciliation loop
    // rather than on work started synchronously by the test, so it pays that loop's own scheduling delay
    // on top of the extraction. vi.waitFor's 1000ms default is enough on an idle machine but not while
    // the full suite runs its workers in parallel — which made this the last intermittent failure in the
    // suite. The assertion is unchanged; only the patience is.
    await vi.waitFor(
      () => {
        expect(readIndex(getSettings()).ingested[file]?.ok).toBe(true)
      },
      { timeout: 15_000 }
    )
    // The per-test budget has to clear the waitFor above too: vitest's 5s default would abort the test
    // before that 15s ever elapsed, turning a slow-but-correct run into a failure at the it() line.
  }, 20_000)

  it('marks a changed successfully indexed source for a clean rebuild instead of silently keeping stale intelligence', async () => {
    const file = 'meeting-1.md'
    await writeIndex(getSettings(), {
      ...readIndex(getSettings()),
      ingested: {
        [file]: { at: Date.now(), ok: true, sourceVersion: 'stale-version' }
      }
    } as never)

    expect(startBackfill().queued).toBe(0)
    await vi.waitFor(() => {
      expect((readIndex(getSettings()) as unknown as { sourceRefreshRequested?: boolean }).sourceRefreshRequested).toBe(true)
    }, { timeout: 10_000 })
  })

  it('marks a deleted successfully indexed source for a clean rebuild instead of retaining its derived facts', async () => {
    unlinkSync(join(meetingsFolder, 'meeting-1.md'))
    await writeIndex(getSettings(), {
      ...readIndex(getSettings()),
      ingested: {
        'meeting-1.md': { at: Date.now(), ok: true, sourceVersion: 'current-version' }
      }
    } as never)

    expect(startBackfill().queued).toBe(0)
    await vi.waitFor(() => {
      expect((readIndex(getSettings()) as unknown as { sourceRefreshRequested?: boolean }).sourceRefreshRequested).toBe(true)
    }, { timeout: 10_000 })
  })

  it('does not retry a failed unchanged source before its persisted retry window expires during background reconciliation', async () => {
    unlinkSync(join(meetingsFolder, 'meeting-2.md'))
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key')
    const source = statSync(join(meetingsFolder, 'meeting-1.md'))
    const sourceVersion = `${Math.round(source.mtimeMs)}:${source.size}`
    await writeIndex(getSettings(), {
      ...readIndex(getSettings()),
      ingested: {
        'meeting-1.md': { at: Date.now(), ok: false, sourceVersion, retryAfter: Date.now() + 60_000, attempts: 1 }
      }
    } as never)

    expect(startBackfill(undefined, { respectRetryBackoff: true }).queued).toBe(0)
  })
})
