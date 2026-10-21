import { describe, expect, it, vi } from 'vitest'
import type { ReceiptJournalPort, SaveReceiptRecord } from '../../infra/storage/transcript-receipt-journal'
import { resumeJournaledSaves, type ResumeDeps, type SavedReceiptIdentityCheck } from './transcript-save-resume'

const STARTED_AT = 1_700_000_000_000

function record(overrides: Partial<SaveReceiptRecord> = {}): SaveReceiptRecord {
  return {
    receiptId: 'receipt-1',
    ownerKey: `1:${STARTED_AT}`,
    authGeneration: 1,
    meetingStartedAt: STARTED_AT,
    payloadSha256: 'a'.repeat(64),
    revision: 0,
    stages: {
      draftSealed: false,
      savedWritten: true,
      brainIngestQueued: false,
      draftsUnlinked: false,
      receiptsDeleted: false
    },
    completed: [],
    savedBasename: '2023-11-14_221320-planning.md',
    folderIdSha256: 'b'.repeat(64),
    updatedAt: 1,
    ...overrides
  }
}

function harness(
  options: {
    check?: ResumeDeps['folder']['verifySavedIdentity']
    stages?: Partial<ResumeDeps['stages']>
    initial?: SaveReceiptRecord
  } = {}
) {
  let current = options.initial ?? record()
  const journal: ReceiptJournalPort = {
    load: vi.fn(async () => ({ ok: true as const, records: [current] })),
    put: vi.fn(async (next) => {
      current = next
    }),
    remove: vi.fn(async () => {
      current = undefined as unknown as SaveReceiptRecord
    })
  }
  const events: string[] = []
  const deps: ResumeDeps = {
    journal,
    folder: {
      join: (name) => `/sandbox/meetings/${name}`,
      idSha256: 'b'.repeat(64),
      verifySavedIdentity: options.check ?? vi.fn(async (): Promise<SavedReceiptIdentityCheck> => 'match')
    },
    stages: {
      'draft-cleanup': options.stages?.['draft-cleanup'] ?? (async () => void events.push('draft-cleanup')),
      rebuild: options.stages?.rebuild ?? (async () => void events.push('rebuild')),
      ingest: options.stages?.ingest ?? (async () => void events.push('ingest'))
    },
    deferredDefault: false,
    now: () => 2
  }
  return { deps, journal, events, current: () => current }
}

describe('resumeJournaledSaves saved identity gate', () => {
  it('waits for the actual asynchronous identity result before running stages', async () => {
    let resolveIdentity!: (value: 'match') => void
    let entered!: () => void
    const verifierStarted = new Promise<void>((resolve) => (entered = resolve))
    const identity = new Promise<'match'>((resolve) => (resolveIdentity = resolve))
    const check = vi.fn(async () => {
      entered()
      return identity
    })
    const h = harness({ check })
    const running = resumeJournaledSaves(h.deps)
    await verifierStarted
    expect(h.events).toEqual([])
    resolveIdentity('match')
    const result = await running
    expect(result.finished).toBe(1)
    expect(h.events).toEqual(['draft-cleanup', 'rebuild', 'ingest'])
    expect(check).toHaveBeenCalledTimes(3)
    expect(h.journal.remove).toHaveBeenCalledOnce()
  })

  it('keeps the completed marker and stops when identity changes during an awaited stage', async () => {
    let releaseCleanup!: () => void
    let cleanupStarted!: () => void
    const started = new Promise<void>((resolve) => (cleanupStarted = resolve))
    const cleanupGate = new Promise<void>((resolve) => (releaseCleanup = resolve))
    const check = vi.fn().mockResolvedValueOnce('match').mockResolvedValueOnce('mismatch')
    const events: string[] = []
    const h = harness({
      check,
      stages: {
        'draft-cleanup': async () => {
          events.push('draft-cleanup')
          cleanupStarted()
          await cleanupGate
        },
        rebuild: async () => void events.push('rebuild'),
        ingest: async () => void events.push('ingest')
      }
    })
    const running = resumeJournaledSaves(h.deps)
    await started
    releaseCleanup()
    const result = await running
    expect(result).toMatchObject({ finished: 0, kept: 1, dropped: 0 })
    expect(h.current()?.completed).toEqual(['draft-cleanup'])
    expect(events).toEqual(['draft-cleanup'])
    expect(check).toHaveBeenCalledTimes(2)
    expect(h.journal.remove).not.toHaveBeenCalled()
  })

  it('drops only an authoritatively missing file before any resumption stage', async () => {
    const h = harness({ check: vi.fn(async (): Promise<SavedReceiptIdentityCheck> => 'missing') })
    const result = await resumeJournaledSaves(h.deps)
    expect(result).toMatchObject({ finished: 0, kept: 0, dropped: 1 })
    expect(h.events).toEqual([])
    expect(h.journal.remove).toHaveBeenCalledOnce()
  })

  it('preserves markers and keeps the receipt if the file disappears after a stage', async () => {
    const check = vi.fn().mockResolvedValueOnce('match').mockResolvedValueOnce('missing')
    const h = harness({ check })
    const result = await resumeJournaledSaves(h.deps)
    expect(result).toMatchObject({ finished: 0, kept: 1, dropped: 0 })
    expect(h.current()?.completed).toEqual(['draft-cleanup'])
    expect(h.events).toEqual(['draft-cleanup'])
    expect(h.journal.remove).not.toHaveBeenCalled()
  })

  it.each([
    'mismatch',
    'unavailable'
  ] as const)('keeps the receipt and runs no stage on %s identity', async (outcome) => {
    const h = harness({ check: vi.fn(async () => outcome) })
    const result = await resumeJournaledSaves(h.deps)
    expect(result).toMatchObject({ finished: 0, kept: 1, dropped: 0 })
    expect(h.events).toEqual([])
    expect(h.current()?.completed).toEqual([])
    expect(h.journal.remove).not.toHaveBeenCalled()
  })

  it('keeps the receipt on a verifier exception or a different folder identity', async () => {
    const thrown = harness({ check: vi.fn(async () => Promise.reject(new Error('read failed'))) })
    expect(await resumeJournaledSaves(thrown.deps)).toMatchObject({ finished: 0, kept: 1 })
    expect(thrown.events).toEqual([])

    const verifyOtherFolder = vi.fn(async () => 'match' as const)
    const otherFolder = harness({ check: verifyOtherFolder, initial: record({ folderIdSha256: 'c'.repeat(64) }) })
    expect(await resumeJournaledSaves(otherFolder.deps)).toMatchObject({ finished: 0, kept: 1 })
    expect(verifyOtherFolder).not.toHaveBeenCalled()
  })
})
