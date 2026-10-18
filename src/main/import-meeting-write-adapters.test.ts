import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type SaveMeeting } from '@shared/ipc'
import { createImportMeetingWriteAdapters } from './import-meeting-write-adapters'
import { ImportJobManager, type ImportJob, type ImportJobStore } from './import-jobs'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

// Models the storage sink's asynchronous preparation followed by its guarded replacement boundary.
// No write is recorded unless the forwarded callback admits it after the hold is released.
function heldCommit() {
  const entered = deferred()
  const release = deferred()
  const writes: string[] = []
  return {
    entered,
    release,
    writes,
    async write(value: string, beforeReplace?: () => void) {
      entered.resolve()
      await release.promise
      beforeReplace?.()
      writes.push(value)
    }
  }
}

const meeting: SaveMeeting = {
  title: 'Synthetic import', mode: 'meeting', startedAt: 1, durationMs: 1000, lines: [], recap: ''
}

function fixture(sink = heldCommit()) {
  let settings = { ...DEFAULT_SETTINGS }
  const getSettings = vi.fn(() => settings)
  const saveMeeting = vi.fn<Parameters<typeof createImportMeetingWriteAdapters>[0]['saveMeeting']>(
    async (_settings, _meeting, beforeReplace) => {
      await sink.write('saved-import.md', beforeReplace)
      return 'saved-import.md'
    }
  )
  const updateMeetingRecap = vi.fn<Parameters<typeof createImportMeetingWriteAdapters>[0]['updateMeetingRecap']>(
    async (_settings, _file, recap, _status, beforeReplace) => {
      await sink.write(recap, beforeReplace)
      return { ok: true }
    }
  )
  const adapters = createImportMeetingWriteAdapters({ getSettings, saveMeeting, updateMeetingRecap })
  return {
    ...adapters, sink, getSettings, saveSink: saveMeeting, recapSink: updateMeetingRecap,
    setSettings(next: typeof settings) { settings = next }
  }
}

describe('main import meeting write adapters', () => {
  it('reads settings at each call and forwards the exact save payload and guard to a successful commit', async () => {
    const f = fixture()
    expect(f.getSettings).not.toHaveBeenCalled()
    const settings = { ...DEFAULT_SETTINGS, encryptTranscripts: !DEFAULT_SETTINGS.encryptTranscripts }
    f.setSettings(settings)
    const guard = vi.fn()
    const saving = f.saveMeeting(meeting, guard)
    expect(saving).toBe(f.saveSink.mock.results[0].value)
    await f.sink.entered.promise
    expect(f.getSettings).toHaveBeenCalledTimes(1)
    expect(f.saveSink).toHaveBeenCalledWith(settings, meeting, guard)
    expect(f.saveSink.mock.calls[0][1]).toBe(meeting)
    expect(guard).not.toHaveBeenCalled()
    expect(f.sink.writes).toEqual([])
    f.sink.release.resolve()
    await expect(saving).resolves.toBe('saved-import.md')
    expect(guard).toHaveBeenCalledTimes(1)
    expect(f.sink.writes).toEqual(['saved-import.md'])

    const nextSettings = { ...DEFAULT_SETTINGS }
    f.setSettings(nextSettings)
    await f.saveMeeting(meeting)
    expect(f.getSettings).toHaveBeenCalledTimes(2)
    expect(f.saveSink.mock.calls[1][0]).toBe(nextSettings)
    expect(f.saveSink.mock.calls[1][2]).toBeUndefined()
  })

  it('forwards the exact recap inputs and guard and maps successful commit to void', async () => {
    const f = fixture()
    const guard = vi.fn()
    const settings = { ...DEFAULT_SETTINGS }
    f.setSettings(settings)
    const recapping = f.updateRecap('saved-import.md', 'Synthetic summary', 'complete', guard)
    await f.sink.entered.promise
    expect(f.getSettings).toHaveBeenCalledTimes(1)
    expect(f.recapSink).toHaveBeenCalledWith(settings, 'saved-import.md', 'Synthetic summary', 'complete', guard)
    expect(guard).not.toHaveBeenCalled()
    expect(f.sink.writes).toEqual([])
    f.sink.release.resolve()
    await expect(recapping).resolves.toBeUndefined()
    expect(guard).toHaveBeenCalledTimes(1)
    expect(f.sink.writes).toEqual(['Synthetic summary'])
  })

  it.each(['save', 'recap'] as const)('prevents the held %s commit when its original guard becomes stale', async (kind) => {
    const f = fixture()
    const stale = new Error('Synthetic attempt no longer owns this write')
    let current = true
    const guard = vi.fn(() => { if (!current) throw stale })
    const writing = kind === 'save'
      ? f.saveMeeting(meeting, guard)
      : f.updateRecap('saved-import.md', 'Synthetic summary', 'complete', guard)
    await f.sink.entered.promise
    expect(guard).not.toHaveBeenCalled()
    current = false
    const refused = expect(writing).rejects.toBe(stale)
    f.sink.release.resolve()
    await refused
    expect(guard).toHaveBeenCalledTimes(1)
    expect(f.sink.writes).toEqual([])
    expect(f.saveSink).toHaveBeenCalledTimes(kind === 'save' ? 1 : 0)
    expect(f.recapSink).toHaveBeenCalledTimes(kind === 'recap' ? 1 : 0)
  })

  it.each(['save', 'recap'] as const)('propagates a rejected %s dependency without replacing the error', async (kind) => {
    const f = fixture()
    const error = new Error('Synthetic storage rejection')
    if (kind === 'save') {
      f.saveSink.mockRejectedValueOnce(error)
      await expect(f.saveMeeting(meeting)).rejects.toBe(error)
    } else {
      f.recapSink.mockRejectedValueOnce(error)
      await expect(f.updateRecap('saved-import.md', 'Synthetic summary', 'complete')).rejects.toBe(error)
    }
    expect(f.sink.writes).toEqual([])
  })

  it.each([
    ['Synthetic recap failure', 'Synthetic recap failure'],
    [undefined, 'Could not save the imported summary.'],
    ['', 'Could not save the imported summary.']
  ])('preserves recap failure mapping for %s', async (error, expected) => {
    const f = fixture()
    f.recapSink.mockResolvedValueOnce({ ok: false, error })
    await expect(f.updateRecap('saved-import.md', 'Synthetic summary', 'complete')).rejects.toThrow(expected)
    expect(f.sink.writes).toEqual([])
  })

  it.each([
    ['save', 'current'], ['save', 'retention'], ['save', 'retention-restored'], ['save', 'cancel'],
    ['recap', 'current'], ['recap', 'retention'], ['recap', 'retention-restored'], ['recap', 'cancel']
  ] as const)('routes the manager-owned %s guard through the adapter with %s ownership', async (kind, ownership) => {
    const f = fixture()
    const jobs = new Map<string, ImportJob>()
    const markHeld = vi.fn(async (jobId: string) => jobs.has(jobId))
    const store: ImportJobStore = {
      async save(job, beforeReplace) {
        beforeReplace?.()
        jobs.set(job.jobId, structuredClone(job))
      },
      async list() { return [...jobs.values()].map((job) => structuredClone(job)) },
      async remove(jobId) { jobs.delete(jobId) },
      markHeld
    }
    let canRetain = true
    const savePort = vi.fn(f.saveMeeting)
    const recapPort = vi.fn(f.updateRecap)
    const enqueueIngest = vi.fn()
    const savedFiles = new Set<string>()
    const deleteMeeting = vi.fn(async (file: string) => { savedFiles.delete(file) })
    if (kind === 'recap') {
      // Reach recap through an admitted initial save; only the target replacement is held.
      f.saveSink.mockImplementationOnce(async (_settings, _meeting, beforeReplace) => {
        beforeReplace?.()
        savedFiles.add('saved-import.md')
        return 'saved-import.md'
      })
    }
    const manager = new ImportJobManager({
      store,
      decode: () => {},
      transcribe: async () => 'Synthetic recognized speech',
      saveMeeting: savePort,
      updateRecap: recapPort,
      generateRecap: async () => kind === 'recap' ? 'Synthetic summary' : undefined,
      enqueueIngest,
      deleteMeeting,
      canRetainTranscript: () => canRetain,
      // Use the existing bounded slab path, without hardware-dependent VAD admission.
      freeMemoryBytes: () => 0,
      now: () => 1_700_000_000_000,
      newId: () => 'adapter-job'
    })
    const job = await manager.start({
      path: '/synthetic/adapter.wav', name: 'adapter.wav', sizeBytes: 42, mtimeMs: 1_700_000_000_000
    })
    await manager.acceptDecodedChunk(job.jobId, 0, 1, new Float32Array(1_600).fill(0.1))
    const finalizing = manager.finishDecoding(job.jobId, 1)
    await f.sink.entered.promise
    const forwardedGuard = kind === 'save' ? f.saveSink.mock.calls[0][2] : f.recapSink.mock.calls[0][4]
    const managerGuard = kind === 'save' ? savePort.mock.calls[0][1] : recapPort.mock.calls[0][3]
    expect(managerGuard).toBeTypeOf('function')
    expect(forwardedGuard).toBe(managerGuard)
    expect(f.sink.writes).toEqual([])

    if (ownership === 'retention' || ownership === 'retention-restored') {
      canRetain = false
      expect(await manager.snapshot()).toMatchObject({
        jobs: [], policyBlocked: true, heldJobIds: [job.jobId], policyHeldJobIds: [job.jobId]
      })
      expect(markHeld).toHaveBeenCalledWith(job.jobId)
      expect(jobs.has(job.jobId)).toBe(true)
      expect(manager.get(job.jobId)).toBeUndefined()
      // Restoring policy does not resume this attempt. Its held ownership must still refuse the write,
      // and the stale-error cleanup branch must preserve a non-cancelled import's existing file.
      if (ownership === 'retention-restored') canRetain = true
    } else if (ownership === 'cancel') await manager.cancel(job.jobId)
    f.sink.release.resolve()
    await finalizing

    if (ownership === 'retention') expect(manager.get(job.jobId)).toBeUndefined()
    else expect(manager.get(job.jobId)?.state).toBe(
      ownership === 'current' ? 'done' : ownership === 'cancel' ? 'cancelled' : 'policy-held'
    )
    expect(f.sink.writes).toEqual(ownership === 'current'
      ? [kind === 'save' ? 'saved-import.md' : 'Synthetic summary'] : [])
    if (ownership === 'current') expect(enqueueIngest).toHaveBeenCalledTimes(1)
    else expect(enqueueIngest).not.toHaveBeenCalled()
    if (kind === 'recap' && ownership === 'cancel') {
      expect(deleteMeeting).toHaveBeenCalledWith('saved-import.md')
      expect(savedFiles.size).toBe(0)
      expect(manager.get(job.jobId)?.file).toBeUndefined()
      expect(jobs.has(job.jobId)).toBe(false)
    } else expect(deleteMeeting).not.toHaveBeenCalled()
    if (kind === 'recap' && ownership !== 'cancel') expect(savedFiles.has('saved-import.md')).toBe(true)
    if (kind === 'save' && ownership !== 'current') expect(manager.get(job.jobId)?.file).toBeUndefined()
  })
})
