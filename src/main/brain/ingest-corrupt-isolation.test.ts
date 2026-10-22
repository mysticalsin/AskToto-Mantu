/**
 * GATE-05 / R-14: brain ingest isolates a corrupt, undecryptable, oversized, dataless or non-regular meeting
 * file. The good meetings beside it are extracted and recorded; each bad file gets its own failed (or
 * skipped) record with a path-free reason; no bad file's bytes reach the model; the folder is not modified;
 * and a second pass neither re-sends a good meeting nor stalls on a bad one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import { PROVIDER_IDS } from '@shared/providers'
import { BrainIndexSchema } from '@shared/brain'
import type { StreamHandlers, StreamOptions, StreamHandle } from '../llm/shared'
import { clearApiKey, getSettings, setApiKey, setSettings } from '../store'
import { brainBackfillProgress, ingestFailureCounts, ingestFailureDetails, startBackfill } from './ingest'
import { readIndex } from './store'
import { saveMeeting } from '../transcripts'
import { useStorageForTests } from '../infra/storage/meetings-storage'
import { settleBrainWritesForTests } from '../test-helpers/settle-brain-writes'
import { installSpeechReadPolicy } from './__fixtures__/speech-read-policy'
import { ALPHA, FRENCH } from '../__fixtures__/golden-meetings'

vi.mock('electron')

const createStreamMock = vi.hoisted(() => vi.fn())
vi.mock('../llm', () => ({ createStream: createStreamMock }))

const READ_LIMIT_BYTES = 30_000

const NAMES = {
  undecryptable: '2026-01-01_000001-synthetic-undecryptable.md',
  truncated: '2026-01-01_000002-synthetic-truncated.md',
  oversized: '2026-01-01_000003-synthetic-oversized.md',
  dataless: '2026-01-01_000004-synthetic-cloud-only.md',
  directory: '2026-01-01_000005-synthetic-directory.md',
  empty: '2026-01-01_000006-synthetic-empty.md'
} as const
const BAD = Object.values(NAMES)

const respondJson =
  (json = '{}') =>
  (opts: StreamOptions & { handlers: StreamHandlers }): StreamHandle => {
    queueMicrotask(() => {
      opts.handlers.onDelta(json)
      opts.handlers.onDone({})
    })
    return { abort: () => {} }
  }

describe('brain ingest isolates unusable meeting files (GATE-05, R-14)', () => {
  let userData: string
  let meetingsFolder: string
  let restorePolicy: () => void
  let cloudOnly: Set<string>
  let good: string[]
  const digests = new Map<string, string>()

  const waitForIdle = async (): Promise<void> => {
    await vi.waitFor(() => expect(brainBackfillProgress().running).toBe(false), { timeout: 10_000 })
    await settleBrainWritesForTests()
  }
  const sha = (name: string): string =>
    createHash('sha256')
      .update(readFileSync(join(meetingsFolder, name)))
      .digest('hex')
  const sent = (): string => JSON.stringify(createStreamMock.mock.calls.map((c) => c[0]))

  beforeEach(async () => {
    restorePolicy = installSpeechReadPolicy({
      maxRecords: 100,
      maxWords: 1000,
      maxFieldBytes: 10_000,
      maxRecordBytes: 20_000,
      maxPayloadBytes: READ_LIMIT_BYTES
    })
    cloudOnly = new Set()
    useStorageForTests({
      detector: {
        classify: async (files) =>
          new Map(files.map((f) => [f.path, cloudOnly.has(f.path) ? 'dataless' : 'local'] as const))
      }
    })
    userData = realpathSync.native(mkdtempSync(join(tmpdir(), 'metis-corrupt-ingest-user-')))
    meetingsFolder = realpathSync.native(mkdtempSync(join(tmpdir(), 'metis-corrupt-ingest-meetings-')))
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'userData' ? userData : join(userData, name)
    )
    for (const p of PROVIDER_IDS) clearApiKey(p)
    for (const name of Object.keys(process.env)) {
      if (name.endsWith('_API_KEY')) vi.stubEnv(name, undefined)
    }
    setSettings({ meetingsFolder })
    setApiKey('anthropic', 'synthetic-anthropic-key')
    createStreamMock.mockReset()
    createStreamMock.mockImplementation(respondJson())

    good = [
      basename(await saveMeeting(getSettings(), ALPHA.meeting)),
      basename(await saveMeeting(getSettings(), FRENCH.meeting))
    ]
    writeFileSync(
      join(meetingsFolder, NAMES.undecryptable),
      Buffer.concat([Buffer.from('ATKENC2\n'), Buffer.from('not json{{{')])
    )
    writeFileSync(
      join(meetingsFolder, NAMES.truncated),
      Buffer.concat([Buffer.from('ATKENC2\n'), Buffer.from('{"v":2,"ct":"AAAA')])
    )
    writeFileSync(
      join(meetingsFolder, NAMES.oversized),
      `---\ntype: meeting-transcript\ntitle: Synthetic oversized\n---\n${'synthetic filler line\n'.repeat(3_000)}`
    )
    const dataless = join(meetingsFolder, NAMES.dataless)
    writeFileSync(dataless, '---\ntype: meeting-transcript\ntitle: Synthetic cloud only\n---\nCLOUDONLY-CONTENT\n')
    cloudOnly.add(dataless)
    mkdirSync(join(meetingsFolder, NAMES.directory))
    writeFileSync(join(meetingsFolder, NAMES.empty), '')
    for (const name of BAD) if (name !== NAMES.directory) digests.set(name, sha(name))
  })

  afterEach(async () => {
    try {
      await settleBrainWritesForTests()
    } finally {
      rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      rmSync(meetingsFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      digests.clear()
      vi.unstubAllEnvs()
      vi.restoreAllMocks()
      restorePolicy()
    }
  })

  it('extracts every good meeting and records each bad file separately, with no bad bytes sent to the model', async () => {
    await startBackfill()
    await waitForIdle()

    const idx = readIndex(getSettings())
    expect(BrainIndexSchema.safeParse(idx).success).toBe(true)
    for (const name of good) expect(idx.ingested[name]).toMatchObject({ ok: true })

    // Exactly the good meetings reached the model, once each.
    expect(createStreamMock).toHaveBeenCalledTimes(good.length)
    const payload = sent()
    for (const leaked of ['not json{{{', 'AAAA', 'filler line', 'CLOUDONLY-CONTENT'])
      expect(payload).not.toContain(leaked)

    // A bad file is never recorded as ingested, and its failure names a reason without a path.
    for (const name of BAD) expect(idx.ingested[name]?.ok ?? false).toBe(false)
    // An empty file is not a meeting (History drops it too): no record at all, so no "Failed to index" item.
    expect(idx.ingested[NAMES.empty]).toBeUndefined()
    const details = ingestFailureDetails(idx)
    expect(details.map((d) => d.file)).not.toContain(NAMES.empty)
    for (const d of details) {
      expect(BAD).toContain(d.file)
      expect(d.error).not.toContain(meetingsFolder)
      expect(d.error.length).toBeGreaterThan(0)
    }
    expect(ingestFailureCounts(idx).failed).toBe(details.length)
    console.log(JSON.stringify(details), JSON.stringify(Object.keys(idx.ingested)))
  })

  it('a read failure spends no extraction attempt, so a repaired file is picked up without a manual reset', async () => {
    await startBackfill()
    await waitForIdle()
    const idx = readIndex(getSettings())
    for (const name of BAD) {
      expect(idx.ingested[name]?.attempts ?? 0).toBe(0)
      expect(idx.ingested[name]?.exhausted).toBeFalsy()
    }
  })

  it('leaves the folder exactly as it found it', async () => {
    // The brain keeps its own .brain directory beside the meetings; nothing else may appear or change.
    const meetingEntries = (): string[] =>
      readdirSync(meetingsFolder)
        .filter((n) => n !== '.brain')
        .sort()
    const before = meetingEntries()
    await startBackfill()
    await waitForIdle()
    expect(meetingEntries()).toEqual(before)
    for (const [name, digest] of digests) expect(sha(name)).toBe(digest)
  })

  it('a second pass is idempotent: no good meeting is sent again and the bad files do not stall it', async () => {
    await startBackfill()
    await waitForIdle()
    const firstCalls = createStreamMock.mock.calls.length
    const firstIndex = readIndex(getSettings())

    await startBackfill()
    await waitForIdle()

    expect(createStreamMock.mock.calls.length).toBe(firstCalls)
    const second = readIndex(getSettings())
    for (const name of good) expect(second.ingested[name]).toEqual(firstIndex.ingested[name])
    expect(brainBackfillProgress().running).toBe(false)
  })

  it('an empty file is skipped silently, and ingested once it gains content', async () => {
    await startBackfill()
    await waitForIdle()
    expect(readIndex(getSettings()).ingested[NAMES.empty]).toBeUndefined()
    expect(sent()).not.toContain(NAMES.empty)

    writeFileSync(
      join(meetingsFolder, NAMES.empty),
      '---\ntype: meeting-transcript\ntitle: Synthetic filled\ndate: 2026-01-01T00:00:06.000Z\n---\nFilled synthetic body.\n'
    )
    await startBackfill(undefined, { trigger: 'user' })
    await waitForIdle()
    expect(readIndex(getSettings()).ingested[NAMES.empty]).toMatchObject({ ok: true })
  })

  it('a bad file that is repaired later is ingested on the next pass while the good ones are left alone', async () => {
    await startBackfill()
    await waitForIdle()
    const calls = createStreamMock.mock.calls.length

    // The oversized file is replaced by a normal-sized meeting (as if re-synced), the rest stay bad.
    writeFileSync(
      join(meetingsFolder, NAMES.oversized),
      '---\ntype: meeting-transcript\ntitle: Synthetic repaired\ndate: 2026-01-01T00:00:03.000Z\n---\nRepaired synthetic body.\n'
    )
    await startBackfill(undefined, { trigger: 'user' })
    await waitForIdle()

    const idx = readIndex(getSettings())
    expect(idx.ingested[NAMES.oversized]).toMatchObject({ ok: true })
    for (const name of good) expect(idx.ingested[name]).toMatchObject({ ok: true })
    expect(sent()).toContain('Repaired synthetic body.')
    expect(createStreamMock.mock.calls.length - calls).toBe(1)
  })
})
