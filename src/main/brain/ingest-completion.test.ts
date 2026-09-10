import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import { getSettings, setSettings, setApiKey, clearApiKey } from '../store'
import type { StreamOptions, StreamHandlers } from '../llm/shared'
import { createStream } from '../llm'
import * as brainStore from './store'
import * as publish from './publish'
import { MeetingExtractionSchema } from '@shared/brain'
import { requestBackfillRun, requestSourceRefresh, resumeBackfillIfPending, startBackfill, startRebuild, enqueueIngest, brainBackfillProgress, whenIndexWritesSettle } from './ingest'

vi.mock('electron')
vi.mock('../llm', () => ({ createStream: vi.fn() }))
vi.mock('./publish', async (original) => {
  const actual = await original<typeof import('./publish')>()
  return { ...actual, publishForExtraction: vi.fn(actual.publishForExtraction), publishIndexes: vi.fn(actual.publishIndexes), publishAll: vi.fn(actual.publishAll) }
})

function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

describe('backfill run completion observes real work', () => {
  let profile: string
  let folder: string
  let releases: Array<() => void>
  const success = (opts: StreamOptions & { handlers: StreamHandlers }) => {
    queueMicrotask(() => { opts.handlers.onDelta('{}'); opts.handlers.onDone({}) })
    return { abort: () => {} }
  }
  const meeting = (name: string) => {
    const path = join(folder, name)
    writeFileSync(path, '---\ndate: 2026-01-01\n---\nSynthetic meeting transcript.\n')
    return path
  }
  const trackedGate = () => { const g = gate(); releases.push(g.release); return g }

  beforeEach(() => {
    profile = mkdtempSync(join(tmpdir(), 'metis-completion-profile-'))
    folder = mkdtempSync(join(tmpdir(), 'metis-completion-meetings-'))
    vi.mocked(app.getPath).mockImplementation((name) => name === 'userData' ? profile : join(profile, name))
    for (const name of Object.keys(process.env)) if (name.endsWith('_API_KEY')) vi.stubEnv(name, undefined)
    setSettings({ meetingsFolder: folder, teamTranscriptFolders: [], publishBrainPages: false })
    setApiKey('anthropic', 'synthetic-test-key')
    vi.mocked(createStream).mockReset().mockImplementation(success)
    vi.mocked(publish.publishIndexes).mockClear()
    releases = []
  })
  afterEach(async () => {
    releases.forEach((release) => release())
    vi.restoreAllMocks()
    setApiKey('anthropic', 'synthetic-test-key')
    vi.mocked(createStream).mockImplementation(success)
    setSettings({ meetingsFolder: folder, teamTranscriptFolders: [] })
    startBackfill(undefined, { force: true })
    await vi.waitFor(() => expect(brainBackfillProgress().running).toBe(false), { timeout: 10_000 })
    await whenIndexWritesSettle()
    rmSync(profile, { recursive: true, force: true })
    rmSync(folder, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it('does not complete an empty run before its deferred scan has executed', async () => {
    const run = requestBackfillRun({ force: true })
    let settled = false
    void run.completion.then(() => { settled = true })
    expect(run.result).toEqual({ queued: 0, preparing: true })
    await Promise.resolve()
    expect(settled).toBe(false)
    await expect(run.completion).resolves.toEqual({ ok: true, total: 0, failed: 0 })
  })

  it('waits for final index publication after durable extraction and merge', async () => {
    meeting('one.md')
    const finalPublication = trackedGate()
    let publishing = false
    vi.mocked(publish.publishIndexes).mockImplementationOnce(async () => { publishing = true; await finalPublication.promise })
    const run = requestBackfillRun({ force: true })
    let settled = false
    void run.completion.then(() => { settled = true })
    await vi.waitFor(() => expect(publishing).toBe(true))
    expect(brainStore.readIndex(getSettings()).ingested['one.md']?.ok).toBe(true)
    expect(settled).toBe(false)
    finalPublication.release()
    await expect(run.completion).resolves.toEqual({ ok: true, total: 1, failed: 0 })
    expect(brainStore.readIndex(getSettings()).backfillRequested).toBe(false)
  })

  it('coalesces an existing legacy batch without an early callback or duplicate extraction', async () => {
    meeting('legacy.md')
    const extraction = trackedGate()
    vi.mocked(createStream).mockImplementationOnce((opts) => { void extraction.promise.then(() => success(opts)); return { abort: () => {} } })
    const callback = vi.fn()
    startBackfill(callback)
    const first = requestBackfillRun({ force: true })
    const second = requestBackfillRun({ force: true })
    expect(second.completion).toBe(first.completion)
    expect(callback).not.toHaveBeenCalled()
    extraction.release()
    await expect(first.completion).resolves.toEqual({ ok: true, total: 1, failed: 0 })
    expect(callback).toHaveBeenCalledTimes(1)
    expect(createStream).toHaveBeenCalledTimes(1)
  })

  it('returns a failed outcome for extraction errors and preserves retry intent', async () => {
    meeting('failed.md')
    vi.mocked(createStream).mockImplementation((opts) => { queueMicrotask(() => opts.handlers.onError('synthetic provider failure')); return { abort: () => {} } })
    await expect(requestBackfillRun({ force: true }).completion).resolves.toEqual({ ok: false, error: 'incomplete', total: 1, failed: 1 })
    expect(brainStore.readIndex(getSettings()).ingested['failed.md']?.ok).toBe(false)
    expect(brainStore.readIndex(getSettings()).backfillRequested).toBe(true)
  })

  it('counts deferred sources without pretending no-provider work succeeded', async () => {
    meeting('a.md'); meeting('b.md')
    clearApiKey('anthropic')
    await expect(requestBackfillRun({ force: true }).completion).resolves.toEqual({ ok: false, error: 'no-provider', total: 2, failed: 0 })
    expect(brainStore.readIndex(getSettings()).backfillRequested).toBe(true)
  })

  it('settles a provider lost mid-batch without consuming the remaining source', async () => {
    for (const name of ['a.md', 'b.md', 'c.md', 'd.md']) meeting(name)
    const extraction = trackedGate()
    vi.mocked(createStream).mockImplementation((opts) => { void extraction.promise.then(() => success(opts)); return { abort: () => {} } })
    const run = requestBackfillRun({ force: true })
    await vi.waitFor(() => expect(createStream).toHaveBeenCalledTimes(3))
    clearApiKey('anthropic')
    extraction.release()
    await expect(run.completion).resolves.toEqual({ ok: false, error: 'no-provider', total: 4, failed: 0 })
    expect(Object.values(brainStore.readIndex(getSettings()).ingested).filter((row) => row.ok)).toHaveLength(3)
    expect(brainStore.readIndex(getSettings()).backfillRequested).toBe(true)
  })

  it('reports a deferred scan failure instead of succeeding or leaving preparation stuck', async () => {
    const blocked = join(profile, 'not-a-directory')
    writeFileSync(blocked, 'synthetic')
    setSettings({ teamTranscriptFolders: [blocked] })
    await expect(requestBackfillRun({ force: true }).completion).resolves.toEqual({ ok: false, error: 'scan-failed', total: 0, failed: 0 })
    expect(brainBackfillProgress().preparing).toBeFalsy()
    expect(brainStore.readIndex(getSettings()).backfillRequested).toBe(true)
  })

  it('observes rejected detached index writes instead of trusting the swallowed lock tail', async () => {
    vi.spyOn(brainStore, 'writeIndex').mockRejectedValueOnce(new Error('synthetic disk failure'))
    await expect(requestBackfillRun({ force: true }).completion).resolves.toEqual({ ok: false, error: 'write-failed', total: 0, failed: 0 })
    expect(brainStore.readIndex(getSettings()).backfillRequested).toBe(true)
  })

  it('reports final publication rejection and retains durable retry state', async () => {
    meeting('publish.md')
    vi.mocked(publish.publishIndexes).mockRejectedValueOnce(new Error('synthetic publication failure'))
    await expect(requestBackfillRun({ force: true }).completion).resolves.toEqual({ ok: false, error: 'publication-failed', total: 1, failed: 0 })
    expect(brainStore.readIndex(getSettings()).backfillRequested).toBe(true)
  })

  it('repairs a local checkpoint without requiring a provider', async () => {
    meeting('checkpoint.md')
    clearApiKey('anthropic')
    await brainStore.writeMeetingExtraction(getSettings(), brainStore.slugify('checkpoint.md'), MeetingExtractionSchema.parse({ title24: 'Synthetic repair' }))
    await expect(requestBackfillRun({ force: true }).completion).resolves.toEqual({ ok: true, total: 1, failed: 0 })
    expect(createStream).not.toHaveBeenCalled()
  })

  it('awaits a source refresh replay and publication without blocking its drain callback', async () => {
    const file = meeting('refresh.md')
    await requestBackfillRun({ force: true }).completion
    await vi.waitFor(() => expect(brainBackfillProgress().running).toBe(false))
    await whenIndexWritesSettle()
    writeFileSync(file, '---\ndate: 2026-01-01\n---\nSynthetic edited meeting, new content.\n')
    const replayPublication = trackedGate()
    let replaying = false
    vi.mocked(publish.publishAll).mockImplementationOnce(async () => { replaying = true; await replayPublication.promise })
    await requestSourceRefresh()
    const run = requestBackfillRun({ force: true })
    let settled = false
    void run.completion.then(() => { settled = true })
    await vi.waitFor(() => expect(replaying).toBe(true))
    expect(settled).toBe(false)
    replayPublication.release()
    await expect(run.completion).resolves.toEqual({ ok: true, total: 1, failed: 0 })
  })

  it('waits for the recap gate then refuses a source version changed after extraction', async () => {
    const file = meeting('recap.md')
    const recap = trackedGate()
    const run = requestBackfillRun({ force: true }, recap.promise)
    let settled = false
    void run.completion.then(() => { settled = true })
    await vi.waitFor(() => expect(brainStore.readIndex(getSettings()).ingested['recap.md']?.ok).toBe(true))
    expect(settled).toBe(false)
    writeFileSync(file, '---\ndate: 2026-01-01\n---\nSynthetic transcript with a newly saved recap.\n')
    recap.release()
    await expect(run.completion).resolves.toEqual({ ok: false, error: 'incomplete', total: 1, failed: 0 })
    expect(brainStore.readIndex(getSettings()).backfillRequested).toBe(true)
  })

  it('checks source freshness again when a file changes during final publication', async () => {
    const file = meeting('during-publication.md')
    await requestBackfillRun({ force: true }).completion
    const publication = trackedGate()
    let publishing = false
    vi.mocked(publish.publishIndexes).mockImplementationOnce(async () => { publishing = true; await publication.promise })
    const run = requestBackfillRun({ force: true })
    await vi.waitFor(() => expect(publishing).toBe(true))
    writeFileSync(file, 'Synthetic changed transcript while publication was pending.\n')
    publication.release()
    await expect(run.completion).resolves.toEqual({ ok: false, error: 'incomplete', total: 1, failed: 0 })
  })

  it('includes a live meeting joining the lane while the recap gate is pending', async () => {
    const recap = trackedGate()
    const run = requestBackfillRun({ force: true }, recap.promise)
    await vi.waitFor(() => expect(brainBackfillProgress().preparing).toBeFalsy())
    const file = meeting('new-live.md')
    await enqueueIngest(file)
    await vi.waitFor(() => expect(brainStore.readIndex(getSettings()).ingested['new-live.md']?.ok).toBe(true))
    recap.release()
    await expect(run.completion).resolves.toEqual({ ok: true, total: 1, failed: 0 })
  })

  it('waits for every coalesced prerequisite and contains a rejected recap', async () => {
    const firstGate = trackedGate()
    const secondGate = trackedGate()
    const first = requestBackfillRun({ force: true }, firstGate.promise)
    const second = requestBackfillRun({ force: true }, secondGate.promise.then(() => { throw new Error('synthetic recap failure') }))
    expect(first.completion).toBe(second.completion)
    let settled = false
    void first.completion.then(() => { settled = true })
    firstGate.release()
    await vi.waitFor(() => expect(brainBackfillProgress().preparing).toBeFalsy())
    expect(settled).toBe(false)
    secondGate.release()
    await expect(first.completion).resolves.toEqual({ ok: false, error: 'incomplete', total: 0, failed: 0 })
    expect(brainStore.readIndex(getSettings()).backfillRequested).toBe(true)
  })

  it('reports source refresh publication failure without wedging its completion callback', async () => {
    const file = meeting('refresh-failure.md')
    await requestBackfillRun({ force: true }).completion
    writeFileSync(file, 'Synthetic edited source for a failed final replay publication.\n')
    vi.mocked(publish.publishAll).mockRejectedValueOnce(new Error('synthetic replay publication failure'))
    await requestSourceRefresh()
    await expect(requestBackfillRun({ force: true }).completion).resolves.toEqual({ ok: false, error: 'publication-failed', total: 1, failed: 0 })
    expect(brainBackfillProgress().running).toBe(false)
    expect(brainStore.readIndex(getSettings()).backfillRequested).toBe(true)
  })

  it('still runs legacy drain callbacks and settles when the index stays unwritable', async () => {
    vi.spyOn(brainStore, 'writeIndex').mockImplementation(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve))
      throw new Error('synthetic persistent disk failure')
    })
    const callback = vi.fn()
    startBackfill(callback, { force: true })
    const run = requestBackfillRun({ force: true })
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1), { timeout: 200, interval: 10 })
    await expect(run.completion).resolves.toEqual({ ok: false, error: 'write-failed', total: 0, failed: 0 })
  })

  it('counts a failed durable job even when writing its failure record also rejects', async () => {
    meeting('write-failure.md')
    const write = brainStore.writeIndex
    vi.spyOn(brainStore, 'writeMeetingExtraction').mockRejectedValueOnce(new Error('synthetic extraction disk failure'))
    vi.spyOn(brainStore, 'writeIndex').mockImplementation(async (settings, idx) => {
      if (idx.ingested['write-failure.md'] && !idx.ingested['write-failure.md'].ok) throw new Error('synthetic failure-ledger write failure')
      return write(settings, idx)
    })
    await expect(requestBackfillRun({ force: true }).completion).resolves.toEqual({ ok: false, error: 'write-failed', total: 1, failed: 1 })
    expect(brainBackfillProgress()).toMatchObject({ running: false, total: 1, done: 1, failed: 1 })
    expect(brainStore.readIndex(getSettings()).backfillRequested).toBe(true)
  })

  it('waits for a newly joined live job even when final publication fails', async () => {
    const publication = trackedGate()
    const extraction = trackedGate()
    let publishing = false
    vi.mocked(publish.publishIndexes).mockImplementationOnce(async () => {
      publishing = true
      await publication.promise
      throw new Error('synthetic late publication failure')
    })
    const run = requestBackfillRun({ force: true })
    let settled = false
    void run.completion.then(() => { settled = true })
    await vi.waitFor(() => expect(publishing).toBe(true))
    vi.mocked(createStream).mockImplementationOnce((opts) => { void extraction.promise.then(() => success(opts)); return { abort: () => {} } })
    await enqueueIngest(meeting('late-live.md'))
    publication.release()
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    expect(settled).toBe(false)
    extraction.release()
    await expect(run.completion).resolves.toEqual({ ok: false, error: 'publication-failed', total: 1, failed: 0 })
  })

  it('retries failed rebuild page publication rather than only refreshing index pages', async () => {
    const file = meeting('retry-replay.md')
    await requestBackfillRun({ force: true }).completion
    writeFileSync(file, 'Synthetic edited source awaiting replay publication.\n')
    vi.mocked(publish.publishAll).mockClear().mockRejectedValueOnce(new Error('synthetic replay publication failure'))
    await requestSourceRefresh()
    await expect(requestBackfillRun({ force: true }).completion).resolves.toMatchObject({ ok: false, error: 'publication-failed' })
    await expect(requestBackfillRun({ force: true }).completion).resolves.toEqual({ ok: true, total: 0, failed: 0 })
    expect(publish.publishAll).toHaveBeenCalledTimes(2)
    expect(brainStore.readIndex(getSettings()).replayPending).toBe(false)
    expect(brainStore.readIndex(getSettings()).backfillRequested).toBe(false)
  })

  it('resumes both pending refresh and replay markers without another purge or duplicate replay', async () => {
    const file = meeting('boot-replay.md')
    await requestBackfillRun({ force: true }).completion
    writeFileSync(file, 'Synthetic changed source for boot publication recovery.\n')
    const purge = vi.spyOn(brainStore, 'purgeBrain')
    vi.mocked(publish.publishAll).mockClear().mockRejectedValueOnce(new Error('synthetic interrupted publication'))
    await requestSourceRefresh()
    await expect(requestBackfillRun({ force: true }).completion).resolves.toMatchObject({ ok: false, error: 'publication-failed' })
    expect(brainStore.readIndex(getSettings())).toMatchObject({ replayPending: true, sourceRefreshRequested: true, backfillRequested: true })
    const publication = trackedGate()
    let retrying = false
    vi.mocked(publish.publishAll).mockImplementationOnce(async () => { retrying = true; await publication.promise })
    resumeBackfillIfPending()
    resumeBackfillIfPending()
    const run = requestBackfillRun({ force: true })
    await vi.waitFor(() => expect(retrying).toBe(true))
    expect(brainStore.readIndex(getSettings())).toMatchObject({ replayPending: true, sourceRefreshRequested: true })
    publication.release()
    await expect(run.completion).resolves.toEqual({ ok: true, total: 0, failed: 0 })
    expect(publish.publishAll).toHaveBeenCalledTimes(2)
    expect(purge).toHaveBeenCalledTimes(1)
    expect(createStream).toHaveBeenCalledTimes(2)
    expect(brainStore.readIndex(getSettings())).toMatchObject({ replayPending: false, sourceRefreshRequested: false, backfillRequested: false })
  })

  it('can retry replay after a refresh scan throws before registering its drain callback', async () => {
    meeting('scan-retry.md')
    await requestBackfillRun({ force: true }).completion
    const blocked = join(profile, 'unavailable-shared-folder')
    writeFileSync(blocked, 'synthetic regular file, not a directory')
    setSettings({ teamTranscriptFolders: [blocked] })
    await requestSourceRefresh()
    await expect(requestBackfillRun({ force: true }).completion).resolves.toEqual({ ok: false, error: 'scan-failed', total: 1, failed: 0 })
    setSettings({ teamTranscriptFolders: [] })
    await expect(requestBackfillRun({ force: true }).completion).resolves.toEqual({ ok: true, total: 1, failed: 0 })
    expect(brainStore.readIndex(getSettings())).toMatchObject({ replayPending: false, sourceRefreshRequested: false, backfillRequested: false })
  })

  it('refuses an overlapping rebuild during publication instead of losing its lifecycle callback', async () => {
    meeting('overlap-replay.md')
    const publication = trackedGate()
    let publishing = false
    vi.mocked(publish.publishAll).mockImplementationOnce(async () => { publishing = true; await publication.promise })
    const purge = vi.spyOn(brainStore, 'purgeBrain')
    await startRebuild(getSettings())
    await vi.waitFor(() => expect(publishing).toBe(true))
    await expect(startRebuild(getSettings())).resolves.toMatchObject({ queued: 0, error: expect.any(String) })
    expect(purge).toHaveBeenCalledTimes(1)
    const run = requestBackfillRun({ force: true })
    publication.release()
    await expect(run.completion).resolves.toMatchObject({ ok: true })
  })

  it('gives only one concurrent rebuild ownership of asynchronous preflight and purge', async () => {
    meeting('overlap-preflight.md')
    const extraction = trackedGate()
    vi.mocked(createStream).mockImplementation((opts) => { void extraction.promise.then(() => success(opts)); return { abort: () => {} } })
    const purge = vi.spyOn(brainStore, 'purgeBrain')
    const results = await Promise.all([startRebuild(getSettings()), startRebuild(getSettings())])
    expect(results.filter((result) => result.error)).toHaveLength(1)
    expect(purge).toHaveBeenCalledTimes(1)
    const run = requestBackfillRun({ force: true })
    extraction.release()
    await expect(run.completion).resolves.toEqual({ ok: true, total: 1, failed: 0 })
  })
})
