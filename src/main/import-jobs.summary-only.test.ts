import { describe, expect, it, vi } from 'vitest'
import type { ImportJob, ImportJobSource, ImportJobStore } from './import-jobs'
import { ImportJobManager } from './import-jobs'
import { ImportRetentionAuthorityUnavailableError, SUMMARY_ONLY_IMPORT_REFUSAL } from './import-retention-policy'

class RetentionStore implements ImportJobStore {
  readonly jobs = new Map<string, ImportJob>()
  readonly held = new Set<string>()
  readonly policyHeld = new Set<string>()
  listCalls = 0
  saveCalls = 0
  inventoryOverflow = false
  failClear = false

  async save(job: ImportJob, beforeReplace?: () => void): Promise<void> {
    beforeReplace?.()
    this.saveCalls += 1
    this.jobs.set(job.jobId, structuredClone(job))
  }

  async list(): Promise<ImportJob[]> {
    this.listCalls += 1
    if (this.inventoryOverflow) return []
    return [...this.jobs.values()].filter((job) => !this.held.has(job.jobId)).map((job) => structuredClone(job))
  }

  async remove(jobId: string): Promise<void> {
    this.jobs.delete(jobId)
    this.held.delete(jobId)
    this.policyHeld.delete(jobId)
  }

  async markExistingJobsHeld(reason: 'policy' | 'restart' = 'restart') {
    for (const id of this.jobs.keys()) this.held.add(id)
    if (reason === 'policy') for (const id of this.held) this.policyHeld.add(id)
    return {
      jobIds: [...this.held],
      policyHeldJobIds: [...this.policyHeld],
      inventoryOverflow: this.inventoryOverflow,
      policyHoldOverflow: false
    }
  }

  async markHeld(jobId: string): Promise<boolean> {
    if (!this.jobs.has(jobId)) return false
    this.held.add(jobId)
    this.policyHeld.add(jobId)
    return true
  }

  async listHeldJobIds() {
    return {
      jobIds: [...this.held],
      policyHeldJobIds: [...this.policyHeld],
      inventoryOverflow: this.inventoryOverflow,
      policyHoldOverflow: false
    }
  }

  async loadHeld(jobId: string): Promise<ImportJob | undefined> {
    if (!this.held.has(jobId)) return undefined
    const job = this.jobs.get(jobId)
    return job ? structuredClone(job) : undefined
  }

  async clearHold(jobId: string): Promise<void> {
    if (this.failClear) throw new Error('marker clear failed')
    this.held.delete(jobId)
    this.policyHeld.delete(jobId)
  }
}

const source: ImportJobSource = {
  path: '/private/source.wav',
  name: 'source.wav',
  sizeBytes: 4096,
  mtimeMs: 1_700_000_000_000
}

function createManager(
  store: RetentionStore,
  canRetain: () => boolean,
  overrides: Partial<ConstructorParameters<typeof ImportJobManager>[0]> = {}
) {
  const decode = vi.fn()
  const transcribe = vi.fn(async () => 'recognized speech')
  const onCancel = vi.fn()
  const disposeSpeakers = vi.fn()
  const validateSource = vi.fn()
  const manager = new ImportJobManager({
    store,
    canRetainTranscript: canRetain,
    validateSource,
    decode,
    transcribe,
    saveMeeting: vi.fn(async () => 'saved-import.md'),
    enqueueIngest: vi.fn(),
    generateRecap: vi.fn(async () => undefined),
    updateRecap: vi.fn(async () => undefined),
    onCancel,
    disposeSpeakers,
    freeMemoryBytes: () => 8 * 1024 * 1024 * 1024,
    totalMemoryBytes: () => 16 * 1024 * 1024 * 1024,
    now: () => 1_700_000_000_000,
    newId: () => 'job-1',
    ...overrides
  })
  return { manager, decode, transcribe, onCancel, disposeSpeakers, validateSource }
}

describe('ImportJobManager summary-only retention boundary', () => {
  it('refuses a batch before creating jobs, writing checkpoints, or starting decoder work', async () => {
    const store = new RetentionStore()
    const { manager, decode } = createManager(store, () => false)

    await expect(manager.startMany([source, { ...source, path: '/private/second.wav' }])).rejects.toThrow(
      SUMMARY_ONLY_IMPORT_REFUSAL
    )

    expect(manager.list()).toEqual([])
    expect(store.jobs.size).toBe(0)
    expect(decode).not.toHaveBeenCalled()
  })

  it('uses the refreshed policy state before creating a requested batch', async () => {
    const store = new RetentionStore()
    const refreshRetentionStatus = vi.fn(async () => 'summary-only' as const)
    const { manager, decode } = createManager(store, () => true, { refreshRetentionStatus })

    await expect(manager.startMany([source])).rejects.toThrow(SUMMARY_ONLY_IMPORT_REFUSAL)

    expect(refreshRetentionStatus).toHaveBeenCalledTimes(1)
    expect(store.jobs.size).toBe(0)
    expect(decode).not.toHaveBeenCalled()
  })

  it('reports unreadable authority separately and refuses before checkpoint payload admission', async () => {
    const store = new RetentionStore()
    const { manager, decode } = createManager(store, () => true, {
      retentionStatus: () => 'unavailable'
    })

    await expect(manager.snapshot()).resolves.toMatchObject({
      jobs: [],
      policyBlocked: true,
      policyState: 'unavailable'
    })
    await expect(manager.start(source)).rejects.toThrow(/policy could not be verified/)
    expect(store.saveCalls).toBe(0)
    expect(store.listCalls).toBe(0)
    expect(decode).not.toHaveBeenCalled()
  })

  it('keeps an exact decode attempt held when admission reported unavailable authority before it restored', async () => {
    const store = new RetentionStore()
    const { manager, decode } = createManager(store, () => true, {
      retentionStatus: () => 'allowed',
      onDecodeAdmission: async () => {
        throw new ImportRetentionAuthorityUnavailableError()
      }
    })

    const job = await manager.start(source)

    expect(manager.get(job.jobId)).toMatchObject({ state: 'policy-held' })
    expect(store.held.has(job.jobId)).toBe(true)
    expect(decode).not.toHaveBeenCalled()
  })

  it('does not retry a typed transcription refusal after policy restores and holds the exact job', async () => {
    let canRetain = true
    const store = new RetentionStore()
    const refused = new ImportRetentionAuthorityUnavailableError()
    const transcribe = vi.fn(async () => {
      canRetain = true
      throw refused
    })
    const { manager } = createManager(store, () => canRetain, {
      freeMemoryBytes: () => 1,
      transcribe
    })
    const job = await manager.start(source)

    await expect(manager.acceptDecodedChunk(job.jobId, 0, 1, new Float32Array(1_600).fill(0.1))).rejects.toBe(refused)

    expect(transcribe).toHaveBeenCalledOnce()
    expect(manager.get(job.jobId)).toBeUndefined()
    expect(store.held.has(job.jobId)).toBe(true)
    expect(store.jobs.get(job.jobId)?.state).not.toBe('failed')
  })

  it('holds existing checkpoints at boot without listing or recovering their transcript payloads', async () => {
    const store = new RetentionStore()
    store.jobs.set('job-1', {
      jobId: 'job-1',
      sourcePath: source.path,
      sourceName: source.name,
      sourceSizeBytes: source.sizeBytes,
      sourceMtimeMs: source.mtimeMs,
      title: 'Private title',
      state: 'failed',
      cursor: 1,
      totalChunks: 2,
      lines: [{ speaker: 'you', text: 'private transcript sentinel', t: 1_700_000_000_000 }],
      createdAt: 1,
      updatedAt: 2
    })
    const { manager, decode } = createManager(store, () => false)

    await expect(manager.recover()).resolves.toEqual([])

    expect(store.listCalls).toBe(0)
    expect(store.held.has('job-1')).toBe(true)
    expect(manager.list()).toEqual([])
    expect(decode).not.toHaveBeenCalled()
    await expect(manager.snapshot()).resolves.toMatchObject({
      jobs: [],
      policyBlocked: true,
      heldJobIds: ['job-1'],
      policyHeldJobIds: ['job-1'],
      inventoryOverflow: false,
      policyHoldOverflow: false
    })
  })

  it('cancels an exact active attempt and keeps its last durable cursor and lines on a policy flip', async () => {
    let canRetain = true
    const store = new RetentionStore()
    const { manager, transcribe, onCancel, disposeSpeakers } = createManager(store, () => canRetain, {
      newId: () => 'job-1',
      decode: vi.fn(),
      beginSpeakers: () => true
    })
    const job = await manager.start(source)
    const committed = structuredClone(store.jobs.get(job.jobId)!)
    canRetain = false

    await manager.acceptDecodedChunk(job.jobId, 0, 1, new Float32Array(1600))

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onCancel).toHaveBeenCalledWith(job.jobId)
    expect(disposeSpeakers).toHaveBeenCalledTimes(1)
    expect(transcribe).not.toHaveBeenCalled()
    expect(store.jobs.get(job.jobId)).toEqual(committed)
    expect(store.held.has(job.jobId)).toBe(true)
    expect(manager.get(job.jobId)).toBeUndefined()
    expect(manager.list()).toEqual([])
  })

  it('keeps a resumed decoder attempt alive when the old hold cleanup finishes afterward', async () => {
    let canRetain = true
    let releaseCancel!: () => void
    let notifyCancel!: () => void
    const cancelStarted = new Promise<void>((resolve) => {
      notifyCancel = resolve
    })
    const cancelGate = new Promise<void>((resolve) => {
      releaseCancel = resolve
    })
    const store = new RetentionStore()
    const onCancel = vi.fn(async () => {
      notifyCancel()
      await cancelGate
    })
    const decode = vi.fn()
    const { manager } = createManager(store, () => canRetain, { onCancel, decode })
    const job = await manager.start(source)

    canRetain = false
    const holding = manager.snapshot()
    await cancelStarted
    canRetain = true
    await manager.resume(job.jobId)
    releaseCancel()
    await holding

    expect(manager.get(job.jobId)?.state).toBe('decoding')
    expect(store.held.has(job.jobId)).toBe(false)
    await expect(
      manager.acceptDecodedChunk(job.jobId, 0, 1, new Float32Array(1_600).fill(0.1))
    ).resolves.toBeUndefined()
    expect(decode).toHaveBeenCalledTimes(2)
  })

  it('ignores a stale decode-admission rejection after the held job has been explicitly resumed', async () => {
    let canRetain = true
    let releaseFirstAdmission!: () => void
    let notifyFirstAdmission!: () => void
    const firstAdmissionStarted = new Promise<void>((resolve) => {
      notifyFirstAdmission = resolve
    })
    const firstAdmissionGate = new Promise<void>((resolve) => {
      releaseFirstAdmission = resolve
    })
    let admissions = 0
    const store = new RetentionStore()
    const decode = vi.fn()
    const onDecodeAdmission = vi.fn(async () => {
      admissions += 1
      if (admissions === 1) {
        notifyFirstAdmission()
        await firstAdmissionGate
        throw new Error('stale admission failure')
      }
    })
    const { manager } = createManager(store, () => canRetain, { decode, onDecodeAdmission })
    const starting = manager.start(source)
    await firstAdmissionStarted
    const jobId = 'job-1'

    canRetain = false
    await manager.snapshot()
    canRetain = true
    await manager.resume(jobId)
    await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(1))
    releaseFirstAdmission()
    await starting

    await vi.waitFor(() => expect(manager.get(jobId)?.state).toBe('decoding'))
    await expect(manager.acceptDecodedChunk(jobId, 0, 1, new Float32Array(1_600).fill(0.1))).resolves.toBeUndefined()
    expect(decode).toHaveBeenCalledTimes(1)
    expect(manager.get(jobId)?.error).toBeUndefined()
  })

  it('rechecks trusted policy after held-ID inventory finishes before returning a snapshot', async () => {
    let canRetain = true
    let releaseInventory!: () => void
    let notifyInventory!: () => void
    const inventoryStarted = new Promise<void>((resolve) => {
      notifyInventory = resolve
    })
    const inventoryGate = new Promise<void>((resolve) => {
      releaseInventory = resolve
    })
    const store = new RetentionStore()
    const originalListHeld = store.listHeldJobIds.bind(store)
    store.listHeldJobIds = async () => {
      notifyInventory()
      await inventoryGate
      return originalListHeld()
    }
    const { manager } = createManager(store, () => canRetain)
    await manager.start(source)

    const snapshot = manager.snapshot()
    await inventoryStarted
    canRetain = false
    releaseInventory()

    await expect(snapshot).resolves.toMatchObject({ jobs: [], policyBlocked: true })
    expect(store.held.has('job-1')).toBe(true)
  })

  it('keeps an already-failed checkpoint explicit-only when policy changes in the current process', async () => {
    let canRetain = true
    const store = new RetentionStore()
    const { manager } = createManager(store, () => canRetain)
    const job = await manager.start(source)
    await manager.failDecoder(job.jobId, new Error('decoder failed'))
    expect(manager.get(job.jobId)).toMatchObject({ state: 'failed' })
    const checkpoint = structuredClone(store.jobs.get(job.jobId))

    canRetain = false
    await expect(manager.snapshot()).resolves.toMatchObject({
      jobs: [],
      policyBlocked: true,
      heldJobIds: [job.jobId],
      policyHeldJobIds: [job.jobId]
    })

    expect(store.jobs.get(job.jobId)).toEqual(checkpoint)
    expect(store.held.has(job.jobId)).toBe(true)
    expect(manager.get(job.jobId)).toBeUndefined()
  })

  it('does not let a held recap continuation persist after policy is restored', async () => {
    let canRetain = true
    let resolveRecap!: (value: string | undefined) => void
    const recapResult = new Promise<string | undefined>((resolve) => {
      resolveRecap = resolve
    })
    const store = new RetentionStore()
    const generateRecap = vi.fn(() => recapResult)
    const updateRecap = vi.fn(async () => undefined)
    const enqueueIngest = vi.fn()
    const recordMeetingSummarized = vi.fn()
    const { manager } = createManager(store, () => canRetain, {
      freeMemoryBytes: () => 0,
      generateRecap,
      updateRecap,
      enqueueIngest,
      recordMeetingSummarized
    })
    const job = await manager.start(source)
    await manager.acceptDecodedChunk(job.jobId, 0, 1, new Float32Array(1_600).fill(0.1))
    const finishing = manager.finishDecoding(job.jobId, 1)
    await vi.waitFor(() => expect(generateRecap).toHaveBeenCalledTimes(1))
    const durableCheckpoint = structuredClone(store.jobs.get(job.jobId))

    canRetain = false
    await manager.snapshot()
    const saveCountAtHold = store.saveCalls
    canRetain = true
    resolveRecap('Private recap')
    await finishing

    expect(store.saveCalls).toBe(saveCountAtHold)
    expect(store.jobs.get(job.jobId)).toEqual(durableCheckpoint)
    expect(store.held.has(job.jobId)).toBe(true)
    expect(updateRecap).not.toHaveBeenCalled()
    expect(enqueueIngest).not.toHaveBeenCalled()
    expect(recordMeetingSummarized).not.toHaveBeenCalled()
    expect(manager.get(job.jobId)).toMatchObject({ state: 'policy-held' })
  })

  it('keeps an authority-refused recap held even if readability returns before its catch runs', async () => {
    let retentionStatus: 'allowed' | 'unavailable' = 'allowed'
    const store = new RetentionStore()
    const enqueueIngest = vi.fn()
    const updateRecap = vi.fn(async (_file: string, _recap: string, _status: string, beforeReplace?: () => void) => {
      retentionStatus = 'unavailable'
      try {
        beforeReplace?.()
      } catch (error) {
        retentionStatus = 'allowed'
        throw error
      }
    })
    const { manager } = createManager(store, () => true, {
      retentionStatus: () => retentionStatus,
      freeMemoryBytes: () => 0,
      generateRecap: vi.fn(async () => 'Private recap'),
      updateRecap,
      enqueueIngest
    })
    const job = await manager.start(source)
    await manager.acceptDecodedChunk(job.jobId, 0, 1, new Float32Array(1_600).fill(0.1))
    await manager.finishDecoding(job.jobId, 1)

    expect(updateRecap).toHaveBeenCalledOnce()
    expect(store.held.has(job.jobId)).toBe(true)
    expect(manager.get(job.jobId)).toMatchObject({ state: 'policy-held' })
    expect(enqueueIngest).not.toHaveBeenCalled()
    expect(store.jobs.get(job.jobId)?.state).not.toBe('failed')
  })

  it('serializes a held marker write before explicit Resume clears it and admits the successor', async () => {
    let canRetain = true
    let releaseMarker!: () => void
    let notifyMarker!: () => void
    const markerStarted = new Promise<void>((resolve) => {
      notifyMarker = resolve
    })
    const markerGate = new Promise<void>((resolve) => {
      releaseMarker = resolve
    })
    const store = new RetentionStore()
    const originalMarkHeld = store.markHeld.bind(store)
    store.markHeld = async (jobId) => {
      notifyMarker()
      await markerGate
      return originalMarkHeld(jobId)
    }
    const { manager, decode } = createManager(store, () => canRetain)
    const job = await manager.start(source)

    canRetain = false
    const holding = manager.snapshot()
    await markerStarted
    canRetain = true
    const resuming = manager.resume(job.jobId)
    await vi.waitFor(() => expect(manager.get(job.jobId)?.state).toBe('queued'))

    releaseMarker()
    await Promise.all([holding, resuming])

    expect(store.held.has(job.jobId)).toBe(false)
    expect(manager.get(job.jobId)?.state).toBe('decoding')
    expect(decode).toHaveBeenCalledTimes(2)
  })

  it('does not let an old checkpoint write replace an explicit resumed snapshot after a policy hold', async () => {
    let canRetain = true
    let releaseBlockedSave!: () => void
    let notifyBlockedSave!: () => void
    const blockedSaveStarted = new Promise<void>((resolve) => {
      notifyBlockedSave = resolve
    })
    const blockedSave = new Promise<void>((resolve) => {
      releaseBlockedSave = resolve
    })
    const store = new RetentionStore()
    const originalSave = store.save.bind(store)
    store.save = async (job, beforeReplace) => {
      if (job.progressPct === 50) {
        // Model the synchronous admission point immediately before the storage rename. Once
        // admitted, this write may finish while a later policy hold is being observed.
        beforeReplace?.()
        notifyBlockedSave()
        await blockedSave
        store.saveCalls += 1
        store.jobs.set(job.jobId, structuredClone(job))
        return
      }
      await originalSave(job, beforeReplace)
    }
    const { manager } = createManager(store, () => canRetain)
    const job = await manager.start(source)
    const pendingProgress = manager.reportProgress(job.jobId, 50)
    await blockedSaveStarted

    canRetain = false
    await manager.snapshot()
    canRetain = true
    const explicitResume = manager.resume(job.jobId)
    releaseBlockedSave()

    await expect(pendingProgress).rejects.toThrow(/summary-only/i)
    await explicitResume
    expect(store.jobs.get(job.jobId)).toMatchObject({ state: 'decoding' })
    expect(store.jobs.get(job.jobId)?.progressPct).toBeUndefined()
    expect(store.held.has(job.jobId)).toBe(false)
  })

  it('rechecks policy and job ownership immediately before saving a completed transcript', async () => {
    let canRetain = true
    let releaseSave!: () => void
    let notifySave!: () => void
    const saveStarted = new Promise<void>((resolve) => {
      notifySave = resolve
    })
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve
    })
    const store = new RetentionStore()
    const saveMeeting = vi.fn(async (_meeting, beforeReplace?: () => void) => {
      notifySave()
      await saveGate
      beforeReplace?.()
      return 'must-not-be-saved.md'
    })
    const { manager } = createManager(store, () => canRetain, {
      freeMemoryBytes: () => 0,
      saveMeeting
    })
    const job = await manager.start(source)
    await manager.acceptDecodedChunk(job.jobId, 0, 1, new Float32Array(1_600).fill(0.1))
    const finalizing = manager.finishDecoding(job.jobId, 1)
    await saveStarted

    canRetain = false
    await manager.snapshot()
    releaseSave()
    await finalizing

    expect(saveMeeting).toHaveBeenCalledTimes(1)
    expect(saveMeeting.mock.calls[0]?.[1]).toBeTypeOf('function')
    expect(manager.get(job.jobId)).toMatchObject({ state: 'policy-held' })
    expect(manager.get(job.jobId)?.file).toBeUndefined()
  })

  it('stops the decoder and detaches PCM before awaiting a slow hold-marker write', async () => {
    let canRetain = true
    let nextId = 1
    let releaseMarker!: () => void
    let notifyMarker!: () => void
    const markerStarted = new Promise<void>((resolve) => {
      notifyMarker = resolve
    })
    const markerGate = new Promise<void>((resolve) => {
      releaseMarker = resolve
    })
    const store = new RetentionStore()
    const originalMarkHeld = store.markHeld.bind(store)
    store.markHeld = async (jobId) => {
      if (jobId === 'job-1') {
        notifyMarker()
        await markerGate
      }
      return originalMarkHeld(jobId)
    }
    const { manager, decode, onCancel } = createManager(store, () => canRetain, {
      newId: () => `job-${nextId++}`
    })
    await manager.startMany([source, { ...source, path: '/private/second.wav' }])
    await manager.acceptDecodedChunk('job-1', 0, 1, new Float32Array(1_600).fill(0.1))
    canRetain = false
    const holding = manager.snapshot()
    await markerStarted

    expect(onCancel).toHaveBeenCalledWith('job-1')
    expect((manager as unknown as { pcmByJob: Map<string, { slabs: Float32Array[] }> }).pcmByJob.has('job-1')).toBe(
      false
    )
    expect(decode).toHaveBeenCalledTimes(1)

    releaseMarker()
    await holding
    expect(decode).toHaveBeenCalledTimes(1)
    expect(store.held.has('job-1')).toBe(true)
    expect(store.held.has('job-2')).toBe(true)
  })

  it('requires fresh policy and source identity, commits before clearing the hold, then explicitly resumes', async () => {
    let canRetain = false
    const store = new RetentionStore()
    store.jobs.set('job-1', {
      jobId: 'job-1',
      sourcePath: source.path,
      sourceName: source.name,
      sourceSizeBytes: source.sizeBytes,
      sourceMtimeMs: source.mtimeMs,
      title: 'Interview',
      state: 'failed',
      cursor: 3,
      totalChunks: 9,
      lines: [{ speaker: 'you', text: 'saved words', t: 1_700_000_000_000 }],
      createdAt: 1,
      updatedAt: 2
    })
    store.held.add('job-1')
    const { manager, decode, validateSource } = createManager(store, () => canRetain)

    await expect(manager.recover()).resolves.toEqual([])
    canRetain = true
    store.failClear = true
    await expect(manager.resume('job-1')).rejects.toThrow(/marker clear failed/i)
    expect(validateSource).toHaveBeenCalledTimes(1)
    expect(decode).not.toHaveBeenCalled()
    expect(store.held.has('job-1')).toBe(true)

    store.failClear = false
    await manager.resume('job-1')
    expect(validateSource).toHaveBeenCalledTimes(2)
    expect(store.held.has('job-1')).toBe(false)
    expect(decode).toHaveBeenCalledTimes(1)
  })

  it('preserves the hold when source identity validation fails', async () => {
    const store = new RetentionStore()
    store.jobs.set('job-1', {
      jobId: 'job-1',
      sourcePath: source.path,
      sourceName: source.name,
      sourceSizeBytes: source.sizeBytes,
      sourceMtimeMs: source.mtimeMs,
      title: 'Interview',
      state: 'failed',
      cursor: 3,
      totalChunks: 9,
      lines: [{ speaker: 'you', text: 'saved words', t: 1_700_000_000_000 }],
      createdAt: 1,
      updatedAt: 2
    })
    store.held.add('job-1')
    const { manager, decode, validateSource } = createManager(store, () => true, {
      validateSource: () => {
        throw new Error('source changed')
      }
    })

    await expect(manager.resume('job-1')).rejects.toThrow('source changed')

    expect(validateSource).toHaveBeenCalledTimes(1)
    expect(store.held.has('job-1')).toBe(true)
    expect(decode).not.toHaveBeenCalled()
  })

  it('does not persist or decode a held resume after authentication is revoked during source validation', async () => {
    let authorized = true
    const store = new RetentionStore()
    store.jobs.set('job-1', {
      jobId: 'job-1',
      sourcePath: source.path,
      sourceName: source.name,
      sourceSizeBytes: source.sizeBytes,
      sourceMtimeMs: source.mtimeMs,
      title: 'Interview',
      state: 'failed',
      cursor: 3,
      totalChunks: 9,
      lines: [{ speaker: 'you', text: 'saved words', t: 1_700_000_000_000 }],
      createdAt: 1,
      updatedAt: 2
    })
    store.held.add('job-1')
    const { manager, decode, validateSource } = createManager(store, () => true, {
      isImportAuthorized: () => authorized,
      validateSource: async () => {
        authorized = false
      }
    })
    await manager.recover()
    const savesBeforeResume = store.saveCalls
    await expect(manager.resume('job-1')).rejects.toThrow('Not signed in.')

    expect(validateSource).toHaveBeenCalledTimes(1)
    expect(store.saveCalls).toBe(savesBeforeResume)
    expect(store.held.has('job-1')).toBe(true)
    expect(decode).not.toHaveBeenCalled()
  })
})
