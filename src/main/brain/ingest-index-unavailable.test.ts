import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomBytes } from 'node:crypto'
import { app, safeStorage } from 'electron'
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
  updateIndex
} from './ingest'
import { brainDir, indexUnavailable, readIndex } from './store'
import { writeSaved } from '../transcripts'
import { useStorageForTests } from '../infra/storage/meetings-storage'
import { settleBrainWritesForTests } from '../test-helpers/settle-brain-writes'
import { resetSecretKeyCache } from '../secrets'

vi.mock('electron')

const createStreamMock = vi.hoisted(() => vi.fn())
vi.mock('../llm', () => ({ createStream: createStreamMock }))

/**
 * M2-0003 — the three gates (updateIndex, startBackfill, enqueueIngest) that stop work from running
 * against the empty in-memory stand-in `readIndex` returns while an existing `.brain/index.json` cannot
 * be decoded on this device. Harness follows ingest-index-fallback.test.ts.
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
    await settleBrainWritesForTests()
  }

  const respondJson = (json = '{}') => (opts: StreamOptions & { handlers: StreamHandlers }): StreamHandle => {
    queueMicrotask(() => {
      opts.handlers.onDelta(json)
      opts.handlers.onDone({})
    })
    return { abort: () => {} }
  }

  const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex')

  const indexJson = (): string => JSON.stringify(readIndex(s))

  const decryptElectronMockBuffer = (buf: Buffer): string => {
    const text = buf.toString('utf8')
    return text.startsWith('enc:') ? text.slice(4) : text
  }

  const restoreElectronMocks = (nextUserData: string): void => {
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      if (name === 'userData') return nextUserData
      return join(nextUserData, name)
    })
    ;(app as typeof app & { isPackaged?: boolean }).isPackaged = false
    ;(safeStorage.isEncryptionAvailable as ReturnType<typeof vi.fn>).mockReturnValue(true)
    ;(safeStorage.encryptString as ReturnType<typeof vi.fn>).mockImplementation((value: string) => Buffer.from(`enc:${value}`))
    ;(safeStorage.decryptString as ReturnType<typeof vi.fn>).mockImplementation(decryptElectronMockBuffer)
  }

  const makeKeychainUnavailable = (): void => {
    ;(safeStorage.isEncryptionAvailable as ReturnType<typeof vi.fn>).mockReturnValue(false)
    ;(safeStorage.encryptString as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('keychain unavailable')
    })
    ;(safeStorage.decryptString as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('keychain unavailable')
    })
  }

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
    useStorageForTests()
    delete process.env.ASKTOTO_LOCAL_KEYSTORE
    resetSecretKeyCache()
    userData = mkdtempSync(join(tmpdir(), 'metis-index-unavailable-ud-'))
    meetingsFolder = mkdtempSync(join(tmpdir(), 'metis-index-unavailable-meetings-'))
    restoreElectronMocks(userData)
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
    delete process.env.ASKTOTO_LOCAL_KEYSTORE
    resetSecretKeyCache()
    restoreElectronMocks(userData)
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    rmSync(meetingsFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    vi.restoreAllMocks()
  })

  it('I1: startBackfill queues nothing and calls no model while the index is unreadable; index.json sha256 and the sentinel are unchanged', async () => {
    const beforeIndex = sha256(readFileSync(primary))
    const beforeSentinel = readFileSync(sentinelPath)

    expect(await startBackfill()).toEqual({ queued: 0 })
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
    const beforeIndex = sha256(readFileSync(primary))

    const r = await startRebuild(s)
    await waitForIdle()

    expect(r.queued).toBeGreaterThan(0)
    expect(createStreamMock).toHaveBeenCalled()
    expect(indexUnavailable(s)).toBeNull()
    expect(readIndex(s).ingested['unreachable-a.md']?.ok).toBe(true)
    const preservedDir = join(meetingsFolder, '.brain-preserved')
    const preserved = readdirSync(preservedDir)
    expect(preserved).toHaveLength(1)
    expect(sha256(readFileSync(join(preservedDir, preserved[0])))).toBe(beforeIndex)
  })

  it('I8: startRebuild reports a keychain refusal message and leaves a keychain-wrapped index unchanged', async () => {
    ;(app as typeof app & { isPackaged?: boolean }).isPackaged = true
    ;(safeStorage.isEncryptionAvailable as ReturnType<typeof vi.fn>).mockReturnValue(true)
    await writeSaved(primary, indexJson(), true)
    const beforeIndex = sha256(readFileSync(primary))
    makeKeychainUnavailable()

    const r = await startRebuild(s)
    await waitForIdle()

    expect(r).toEqual({
      queued: 0,
      error: "Make sure this device can read the existing index (keychain/local key unlocked, file downloaded), then retry. Nothing was changed."
    })
    expect(r.error).toContain('keychain')
    expect(sha256(readFileSync(primary))).toBe(beforeIndex)
    expect(createStreamMock).not.toHaveBeenCalled()
  })
})
