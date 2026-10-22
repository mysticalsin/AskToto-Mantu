import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import { PROVIDER_IDS } from '@shared/providers'
import { DealEntitySchema } from '@shared/brain'
import type { StreamHandlers, StreamOptions, StreamHandle } from '../llm/shared'
import { clearApiKey, getSettings, setApiKey, setSettings } from '../store'
import { acknowledgeMetadataEdit, brainBackfillProgress, enqueueIngest, reconcileMeetingsInBackground } from './ingest'
import { scanMeetingSources, sourceVersions } from './inputs'
import { readDeal, readIndex, writeDeal, writeIndex } from './store'
import { useStorageForTests } from '../infra/storage/meetings-storage'
import { settleBrainWritesForTests } from '../test-helpers/settle-brain-writes'
import { installSpeechReadPolicy } from './__fixtures__/speech-read-policy'

vi.mock('electron')

const createStreamMock = vi.hoisted(() => vi.fn())
vi.mock('../llm', () => ({ createStream: createStreamMock }))

const respondJson = (opts: StreamOptions & { handlers: StreamHandlers }): StreamHandle => {
  queueMicrotask(() => {
    opts.handlers.onDelta('{}')
    opts.handlers.onDone({})
  })
  return { abort: () => {} }
}

describe('source drift: per-meeting re-ingest and a budgeted rebuild (Q04 / D8-1)', () => {
  let userData: string
  let meetingsFolder: string
  let restoreSpeechReadPolicy: () => void = () => {}

  const waitForIdle = async (): Promise<void> => {
    await vi.waitFor(
      () => {
        const p = brainBackfillProgress()
        expect(p.running).toBe(false)
        expect(p.preparing).toBeFalsy()
      },
      { timeout: 15_000 }
    )
    await settleBrainWritesForTests()
  }

  /** Both meetings are recorded as ingested ok. `a.md` carries a stale version unless told otherwise. */
  const seedIndex = async (opts: { aStale: boolean; budgetSpent?: boolean }): Promise<void> => {
    const s = getSettings()
    const versions = sourceVersions(await scanMeetingSources(s))!
    const today = new Date().toLocaleDateString('en-CA')
    await writeIndex(s, {
      ...readIndex(s),
      ingested: {
        'a.md': { at: Date.now(), ok: true, sourceVersion: opts.aStale ? 'stale-version' : versions.get('a.md') },
        'b.md': { at: Date.now(), ok: true, sourceVersion: versions.get('b.md') }
      },
      ...(opts.budgetSpent ? { dailyRunDate: today, dailyRunCount: 3 } : {})
    } as never)
    await writeDeal(s, 'survivor', DealEntitySchema.parse({ name: 'Survivor', account: 'Acme' }))
  }

  beforeEach(() => {
    restoreSpeechReadPolicy = installSpeechReadPolicy()
    useStorageForTests()
    userData = mkdtempSync(join(tmpdir(), 'asktoto-drift-test-'))
    meetingsFolder = mkdtempSync(join(tmpdir(), 'asktoto-drift-meetings-'))
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      if (name === 'userData') return userData
      return join(userData, name)
    })
    for (const p of PROVIDER_IDS) clearApiKey(p)
    for (const name of Object.keys(process.env)) {
      if (name.endsWith('_API_KEY')) vi.stubEnv(name, undefined)
    }
    setSettings({ meetingsFolder, provider: 'anthropic' })
    setApiKey('anthropic', 'fake-anthropic-key')
    createStreamMock.mockReset()
    createStreamMock.mockImplementation(respondJson)
    writeFileSync(join(meetingsFolder, 'a.md'), '---\ndate: 2026-01-01\n---\nAlpha content.', 'utf8')
    writeFileSync(join(meetingsFolder, 'b.md'), '---\ndate: 2026-01-02\n---\nBeta content.', 'utf8')
  })

  afterEach(async () => {
    try {
      await waitForIdle()
    } finally {
      restoreSpeechReadPolicy()
      vi.unstubAllEnvs()
      vi.restoreAllMocks()
      rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      rmSync(meetingsFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })

  it('content drift on a present source re-ingests that key only', async () => {
    await seedIndex({ aStale: true })

    await reconcileMeetingsInBackground()
    await vi.waitFor(() => expect(createStreamMock).toHaveBeenCalled(), { timeout: 15_000 })
    await waitForIdle()

    expect(createStreamMock).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(createStreamMock.mock.calls[0][0])).toContain('Alpha content')
    const idx = readIndex(getSettings())
    expect(idx.sourceRefreshRequested).toBeFalsy()
    expect(idx.ingested['a.md']?.ok).toBe(true)
    expect(idx.ingested['a.md']?.sourceVersion).not.toBe('stale-version')
    // A whole-brain purge would have removed this entity file.
    expect(readDeal(getSettings(), 'survivor')).not.toBeNull()
  })

  it('does not re-ingest a changed source once the daily budget is spent', async () => {
    await seedIndex({ aStale: true, budgetSpent: true })

    await reconcileMeetingsInBackground()
    await waitForIdle()

    expect(createStreamMock).not.toHaveBeenCalled()
    expect(readIndex(getSettings()).ingested['a.md']?.sourceVersion).toBe('stale-version')
    expect(readDeal(getSettings(), 'survivor')).not.toBeNull()
  })

  it('a missing source requests a refresh only within the daily budget', async () => {
    await seedIndex({ aStale: false, budgetSpent: true })
    unlinkSync(join(meetingsFolder, 'a.md'))

    await reconcileMeetingsInBackground()
    await waitForIdle()

    // Budget at 0: no rebuild is requested, nothing is wiped, no model call is made.
    expect(readIndex(getSettings()).sourceRefreshRequested).toBeFalsy()
    expect(createStreamMock).not.toHaveBeenCalled()
    expect(readDeal(getSettings(), 'survivor')).not.toBeNull()
  })

  it('a missing source rebuilds when budget remains', async () => {
    await seedIndex({ aStale: false })
    unlinkSync(join(meetingsFolder, 'a.md'))

    await reconcileMeetingsInBackground()
    await vi.waitFor(() => expect(createStreamMock).toHaveBeenCalled(), { timeout: 15_000 })
    await waitForIdle()

    expect(readDeal(getSettings(), 'survivor')).toBeNull()
    expect(createStreamMock).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(createStreamMock.mock.calls[0][0])).toContain('Beta content')
  })

  it('acknowledging a metadata edit records the new version, so the tick sees no drift', async () => {
    await seedIndex({ aStale: true })
    await acknowledgeMetadataEdit(getSettings(), join(meetingsFolder, 'a.md'))
    const versions = sourceVersions(await scanMeetingSources(getSettings()))!
    expect(readIndex(getSettings()).ingested['a.md']?.sourceVersion).toBe(versions.get('a.md'))

    await reconcileMeetingsInBackground()
    await waitForIdle()

    expect(createStreamMock).not.toHaveBeenCalled()
    expect(readDeal(getSettings(), 'survivor')).not.toBeNull()
  })

  it('Q04b: a content edit on an ok meeting re-ingests that key only, never a whole-brain rebuild', async () => {
    await seedIndex({ aStale: false })
    writeFileSync(join(meetingsFolder, 'a.md'), '---\ndate: 2026-01-01\n---\nAlpha content, edited title.', 'utf8')

    await enqueueIngest(join(meetingsFolder, 'a.md'), { force: true, reingest: true })
    await vi.waitFor(() => expect(createStreamMock).toHaveBeenCalled(), { timeout: 15_000 })
    await waitForIdle()

    expect(createStreamMock).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(createStreamMock.mock.calls[0][0])).toContain('edited title')
    const idx = readIndex(getSettings())
    expect(idx.sourceRefreshRequested).toBeFalsy()
    expect(idx.ingested['a.md']?.ok).toBe(true)
    // A whole-brain purge would have removed this entity file and re-extracted b.md too.
    expect(readDeal(getSettings(), 'survivor')).not.toBeNull()
  })

  it('Q04b: without the reingest option a forced enqueue on an ok meeting still rebuilds (unchanged contract)', async () => {
    await seedIndex({ aStale: false })
    await enqueueIngest(join(meetingsFolder, 'a.md'), { force: true })
    await vi.waitFor(() => expect(createStreamMock).toHaveBeenCalled(), { timeout: 15_000 })
    await waitForIdle()
    expect(readDeal(getSettings(), 'survivor')).toBeNull()
  })

  it('acknowledging a meeting that is not ingested ok adds no record', async () => {
    await acknowledgeMetadataEdit(getSettings(), join(meetingsFolder, 'a.md'))
    expect(readIndex(getSettings()).ingested['a.md']).toBeUndefined()
  })
})
