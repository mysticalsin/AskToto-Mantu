import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomBytes } from 'node:crypto'
import { app } from 'electron'
import type { StreamHandlers, StreamOptions, StreamHandle } from '../llm/shared'
import { getSettings, setApiKey, setSettings } from '../store'
import {
  brainBackfillProgress,
  enqueueIngest,
  markBrainChanged,
  reconcileMeetingsInBackground,
  requestBackfillRun,
  requestSourceRefresh,
  startBackfill,
  startRebuild,
  updateIndex,
  whenIndexWritesSettle
} from './ingest'
import { brainDir, indexUnavailable, readIndex } from './store'

vi.mock('electron')

const createStreamMock = vi.hoisted(() => vi.fn())
vi.mock('../llm', () => ({ createStream: createStreamMock }))

/**
 * M2-0003 — the three gates (updateIndex, startBackfill, enqueueIngest) that stop work from running
 * against the empty in-memory stand-in `readIndex` returns while an existing `.brain/index.json` cannot
 * be decoded on this device. Harness follows ingest-index-fallback.test.ts. See
 * docs/metis-2.0/designs/M2-0003-DESIGN.md §2.4/§5.3.
 *
 * A "sentinel" entity file stands in for every other derived artifact a runaway re-ingest would touch:
 * if it survives untouched, nothing behind the gate ran.
 */
describe('brain ingest — gated behind an unreadable index.json', () => {
  let userData: string
  let meetingsFolder: string
  let s: ReturnType<typeof getSettings>
  let primary: string
  let sentinelPath: string

  const waitForIdle = async (): Promise<void> => {
    await vi.waitFor(() => {
      expect(brainBackfillProgress().running).toBe(false)
    }, { timeout: 10_000 })
    await whenIndexWritesSettle()
  }

  const respondJson = (json = '{}') => (opts: StreamOptions & { handlers: StreamHandlers }): StreamHandle => {
    queueMicrotask(() => {
      opts.handlers.onDelta(json)
      opts.handlers.onDone({})
    })
    return { abort: () => {} }
  }

  const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex')

  /** FOREIGN-F — same incident fixture as mqa-175-brain-index-poison.test.ts / store.test.ts: a v2
   *  envelope whose `kLocal` is not a key any process holds. */
  const foreignKeyIndexBytes = (): Buffer => {
    const marker = Buffer.from('ATKENC2\n', 'utf8')
    const env = {
      v: 2,
      iv: randomBytes(12).toString('base64'),
      tag: randomBytes(16).toString('base64'),
      ct: randomBytes(64).toString('base64'),
      kLocal: 'F:' + randomBytes(72).toString('base64')
    }
    return Buffer.concat([marker, Buffer.from(JSON.stringify(env), 'utf8')])
  }

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'metis-index-unavailable-ud-'))
    meetingsFolder = mkdtempSync(join(tmpdir(), 'metis-index-unavailable-meetings-'))
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      if (name === 'userData') return userData
      return join(userData, name)
    })
    setSettings({ meetingsFolder })
    setApiKey('anthropic', 'fake-anthropic-key')
    createStreamMock.mockReset()
    createStreamMock.mockImplementation(respondJson())

    writeFileSync(join(meetingsFolder, 'unreachable-a.md'), '---\ndate: 2026-01-01\n---\nAcme renewal call one.', 'utf8')
    writeFileSync(join(meetingsFolder, 'unreachable-b.md'), '---\ndate: 2026-01-02\n---\nAcme renewal call two.', 'utf8')

    s = getSettings()
    primary = join(brainDir(s), 'index.json')
    mkdirSync(join(brainDir(s), 'entities', 'person'), { recursive: true })
    sentinelPath = join(brainDir(s), 'entities', 'person', 'sentinel.json')
    writeFileSync(
      sentinelPath,
      JSON.stringify({ schema_version: 2, id: 'sentinel', name: 'Sentinel', meetings: [], quotes: [], stance_trail: [], commitments: [], aliases: [] }),
      'utf8'
    )
    writeFileSync(primary, foreignKeyIndexBytes())
    expect(indexUnavailable(s)).toBe('undecryptable') // sanity: the fixture is actually unreadable here
  })

  afterEach(async () => {
    await waitForIdle()
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    rmSync(meetingsFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    vi.restoreAllMocks()
  })

  it('I1: startBackfill queues nothing and calls no model while the index is unreadable; index.json sha256 and the sentinel are unchanged', async () => {
    const beforeIndex = sha256(readFileSync(primary))
    const beforeSentinel = readFileSync(sentinelPath)

    expect(startBackfill()).toEqual({ queued: 0 })
    await waitForIdle()

    expect(createStreamMock).not.toHaveBeenCalled()
    expect(sha256(readFileSync(primary))).toBe(beforeIndex)
    expect(readFileSync(sentinelPath)).toEqual(beforeSentinel)
  })

  it('I2: the 60s reconcile tick (reconcileMeetingsInBackground) does not re-ingest the vault behind an unreadable index', async () => {
    const beforeIndex = sha256(readFileSync(primary))

    reconcileMeetingsInBackground()
    await waitForIdle()

    expect(createStreamMock).not.toHaveBeenCalled()
    expect(sha256(readFileSync(primary))).toBe(beforeIndex)
  })

  it('I3: a live save (enqueueIngest) is not indexed and does not touch index.json while it is unreadable', async () => {
    const beforeIndex = sha256(readFileSync(primary))

    await enqueueIngest(join(meetingsFolder, 'unreachable-a.md'))
    await waitForIdle()

    expect(createStreamMock).not.toHaveBeenCalled()
    expect(sha256(readFileSync(primary))).toBe(beforeIndex)
    expect(readIndex(s).ingested['unreachable-a.md']).toBeUndefined()
  })

  it('I4: updateIndex and markBrainChanged resolve without persisting anything over an unreadable index', async () => {
    const beforeIndex = sha256(readFileSync(primary))

    await expect(updateIndex(s, (idx) => { idx.warnings = ['should never persist'] })).resolves.toBeUndefined()
    await expect(markBrainChanged(s)).resolves.toBeUndefined()

    expect(sha256(readFileSync(primary))).toBe(beforeIndex)
  })

  it('I5: requestSourceRefresh never reaches purgeBrain behind an unreadable index', async () => {
    const beforeIndex = sha256(readFileSync(primary))

    await requestSourceRefresh(s)
    await waitForIdle()

    expect(existsSync(sentinelPath)).toBe(true) // purgeBrain would have deleted the whole .brain dir
    expect(sha256(readFileSync(primary))).toBe(beforeIndex)
  })

  it('I6: requestBackfillRun({force:true}).completion settles (no hang) with queued 0 while the index is unreadable', async () => {
    const { result, completion } = requestBackfillRun({ force: true })
    expect(result.queued).toBe(0)

    const settled = await Promise.race([
      completion.then(() => 'settled' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 8_000))
    ])
    expect(settled).toBe('settled')
    expect(createStreamMock).not.toHaveBeenCalled()
  })

  it('I7: explicit rebuild (startRebuild) is the repair path — it purges and writes a readable index', async () => {
    const r = await startRebuild(s)
    await waitForIdle()

    expect(r.queued).toBeGreaterThan(0)
    expect(createStreamMock).toHaveBeenCalled()
    expect(indexUnavailable(s)).toBeNull()
    expect(readIndex(s).ingested['unreachable-a.md']?.ok).toBe(true)
  })
})
