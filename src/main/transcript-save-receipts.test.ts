import { describe, expect, it, vi } from 'vitest'
import type { Settings } from '@shared/ipc'
import type { ReceiptJournalPort, SaveReceiptRecord } from './infra/storage/transcript-receipt-journal'
import {
  TranscriptSaveReceiptStore,
  type ReceiptJournalOptions,
  type TranscriptSaveReceipt
} from './transcript-save-receipts'

const settings = { meetingsFolder: '/m' } as Settings
const owner = (startedAt: number) => ({ startedAt, authGeneration: 7 })
const key = (n: number) => `7:${n.toString(16).padStart(64, '0')}`

function memoryJournal(): ReceiptJournalPort & { records: Map<string, SaveReceiptRecord>; writes: number } {
  const records = new Map<string, SaveReceiptRecord>()
  const port = {
    records,
    writes: 0,
    load: async () => ({ ok: true as const, records: [...records.values()] }),
    put: async (rec: SaveReceiptRecord) => {
      port.writes++
      records.set(rec.receiptId, structuredClone(rec))
    },
    remove: async (id: string) => {
      port.writes++
      records.delete(id)
    }
  }
  return port
}

function journaled(journal = memoryJournal()): { store: TranscriptSaveReceiptStore; journal: typeof journal } {
  let id = 0
  const options: ReceiptJournalOptions = {
    journal,
    locate: (path) => ({ savedBasename: path.split('/').pop()!, folderIdSha256: 'f'.repeat(64), revision: 4 }),
    newId: () => `rec-${++id}`,
    now: () => 1000
  }
  return { store: new TranscriptSaveReceiptStore(256, options), journal }
}

/** One durable save, as the save handler runs it: identity, settings, durable write, then the named stages. */
const durable =
  (startedAt: number, stages: string[] = []) =>
  async (receipt: any) => {
    receipt.normalizedStartedAt = startedAt
    receipt.settings = settings
    receipt.durablePath = `/m/meeting-${startedAt}.md`
    for (const stage of stages) receipt.completed.add(stage)
    return receipt.durablePath as string
  }

describe('TranscriptSaveReceiptStore', () => {
  it('blocks save effects and success when receipt construction throws', async () => {
    const journal = memoryJournal()
    const failure = new Error('receipt ID unavailable')
    const effect = vi.fn()
    const store = new TranscriptSaveReceiptStore(256, {
      journal,
      locate: () => ({ savedBasename: 'a.md', folderIdSha256: 'f'.repeat(64), revision: 3 }),
      newId: () => {
        throw failure
      }
    })
    const saved = store.run(key(1), owner(42), async (receipt) => {
      receipt.normalizedStartedAt = 42
      receipt.settings = settings
      receipt.durablePath = '/m/a.md'
      await store.journalIdle()
      effect()
      return receipt.durablePath
    })
    await expect(saved).rejects.toBe(failure)
    expect(effect).not.toHaveBeenCalled()
    expect(journal.records.size).toBe(0)
  })

  it.each([
    'locate',
    'newId',
    'now'
  ] as const)('retains a persistent %s failure until an explicit retry', async (boundary) => {
    const journal = memoryJournal()
    const failure = new Error(`${boundary} unavailable`)
    let failing = true
    const check = () => {
      if (failing) throw failure
    }
    const store = new TranscriptSaveReceiptStore(256, {
      journal,
      locate: () => {
        if (boundary === 'locate') check()
        return { savedBasename: 'a.md', folderIdSha256: 'f'.repeat(64), revision: 3 }
      },
      newId: () => {
        if (boundary === 'newId') check()
        return 'fixed'
      },
      now: () => {
        if (boundary === 'now') check()
        return 1000
      }
    })
    const write = vi.fn(() => '/m/a.md')
    const effect = vi.fn()
    const work = vi.fn(async (receipt: TranscriptSaveReceipt) => {
      receipt.normalizedStartedAt ??= 42
      receipt.settings ??= settings
      receipt.durablePath ??= write()
      await store.journalIdle()
      effect()
      return receipt.durablePath
    })
    await expect(store.run(key(1), owner(42), work)).rejects.toBe(failure)
    await expect(store.journalIdle()).rejects.toBe(failure)
    await expect(store.run(key(1), owner(42), work)).rejects.toBe(failure)
    expect(work).toHaveBeenCalledTimes(1)
    expect(effect).not.toHaveBeenCalled()
    expect(journal.writes).toBe(0)
    failing = false
    await expect(store.run(key(1), owner(42), work)).resolves.toBe('/m/a.md')
    expect(write).toHaveBeenCalledTimes(1)
    expect(effect).toHaveBeenCalledTimes(1)
    expect(journal.records.get('fixed')).toMatchObject({ ownerKey: '7:42', revision: 3, savedBasename: 'a.md' })
  })

  it.each([
    undefined,
    null,
    false,
    0,
    ''
  ])('preserves a falsy construction error %s when logging throws', async (failure) => {
    const journal = memoryJournal()
    const newId = vi.fn(() => {
      throw failure
    })
    const onError = vi.fn(() => {
      throw new Error('logger failed')
    })
    const store = new TranscriptSaveReceiptStore(256, {
      journal,
      locate: () => ({ savedBasename: 'a.md', folderIdSha256: 'f'.repeat(64), revision: 3 }),
      newId,
      onError
    })
    await expect(store.run(key(1), owner(42), durable(42))).rejects.toBe(failure)
    expect(newId).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure)
    await expect(store.journalIdle()).rejects.toBe(failure)
    expect(newId).toHaveBeenCalledTimes(2)
    expect(journal.writes).toBe(0)
  })

  it('observes a transient failure before later retry, then holds retry work until the pinned record persists', async () => {
    const journal = memoryJournal()
    const put = journal.put
    const failure = new Error('clock unavailable after credit')
    let failNow = false
    let holdPut = false
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let putting = false
    const location = { savedBasename: 'a.md', folderIdSha256: 'f'.repeat(64), revision: 12 }
    const locate = vi.fn(() => location)
    const newId = vi.fn(() => 'original')
    const store = new TranscriptSaveReceiptStore(256, {
      journal,
      locate,
      newId,
      now: () => {
        if (failNow) {
          failNow = false
          throw failure
        }
        return 1000
      }
    })
    journal.put = async (record) => {
      if (holdPut) {
        putting = true
        await held
      }
      await put(record)
    }
    const write = vi.fn(() => '/m/a.md')
    const credit = vi.fn()
    const nextEffect = vi.fn()
    const work = vi.fn(async (receipt: TranscriptSaveReceipt) => {
      receipt.normalizedStartedAt ??= 42
      receipt.settings ??= settings
      receipt.durablePath ??= write()
      await store.journalIdle()
      if (!receipt.completed.has('summary-credit')) {
        credit()
        failNow = true
        receipt.completed.add('summary-credit')
        await store.journalIdle()
      }
      nextEffect()
      return receipt.durablePath
    })
    let retry: Promise<string> | undefined
    try {
      await expect(store.run(key(1), owner(42), work)).rejects.toBe(failure)
      expect(nextEffect).not.toHaveBeenCalled()
      location.revision = 0
      location.savedBasename = 'later.md'
      holdPut = true
      retry = store.run(key(1), owner(42), work)
      await vi.waitFor(() => expect(putting).toBe(true))
      expect(work).toHaveBeenCalledTimes(1)
      expect(write).toHaveBeenCalledTimes(1)
      expect(credit).toHaveBeenCalledTimes(1)
      release()
      await expect(retry).resolves.toBe('/m/a.md')
      expect(write).toHaveBeenCalledTimes(1)
      expect(credit).toHaveBeenCalledTimes(1)
      expect(nextEffect).toHaveBeenCalledTimes(1)
      expect(locate).toHaveBeenCalledExactlyOnceWith('/m/a.md', settings, 42)
      expect(newId).toHaveBeenCalledTimes(1)
      expect(journal.records.get('original')).toMatchObject({
        ownerKey: '7:42',
        revision: 12,
        savedBasename: 'a.md',
        completed: ['summary-credit']
      })
    } finally {
      release()
      await Promise.allSettled(retry ? [retry] : [])
    }
  })

  it('keeps the failed construction barrier bound while one logger-scheduled caller retries', async () => {
    const journal = memoryJournal()
    const put = journal.put
    const failure = new Error('first ID failed')
    let attempts = 0
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let putting = false
    journal.put = async (record) => {
      putting = true
      await held
      await put(record)
    }
    let retry: Promise<void> | undefined
    const effect = vi.fn()
    const store = new TranscriptSaveReceiptStore(256, {
      journal,
      locate: () => ({ savedBasename: 'a.md', folderIdSha256: 'f'.repeat(64), revision: 3 }),
      newId: () => {
        if (++attempts === 1) throw failure
        return 'retry'
      },
      onError: () =>
        queueMicrotask(() => {
          retry = store.journalIdle()
        })
    })
    const saved = store.run(key(1), owner(42), async (receipt) => {
      receipt.normalizedStartedAt = 42
      receipt.settings = settings
      receipt.durablePath = '/m/a.md'
      await store.journalIdle()
      effect()
      return receipt.durablePath
    })
    // Attach immediately so the deliberately rejected save is always observed.
    const outcome = saved.then(
      () => ({ ok: true }),
      (error: unknown) => ({ ok: false, error })
    )
    try {
      await vi.waitFor(() => expect(putting).toBe(true))
      expect(await outcome).toEqual({ ok: false, error: failure })
      expect(((await outcome) as { error: unknown }).error).toBe(failure)
      expect(effect).not.toHaveBeenCalled()
      expect(attempts).toBe(2)
      release()
      await retry
      expect(journal.records.has('retry')).toBe(true)
    } finally {
      release()
      await Promise.allSettled([outcome, ...(retry ? [retry] : [])])
    }
  })

  it('pins the captured location and assigned ID when the first record clock fails', async () => {
    const journal = memoryJournal()
    const failure = new Error('first record clock failed')
    const location = { savedBasename: 'a.md', folderIdSha256: 'f'.repeat(64), revision: 12 }
    const locate = vi.fn(() => location)
    const newId = vi.fn(() => 'first-id')
    let failing = true
    const store = new TranscriptSaveReceiptStore(256, {
      journal,
      locate,
      newId,
      now: () => {
        if (failing) throw failure
        return 1000
      }
    })
    await expect(store.run(key(1), owner(42), durable(42))).rejects.toBe(failure)
    expect(journal.writes).toBe(0)
    location.savedBasename = 'later.md'
    location.folderIdSha256 = 'e'.repeat(64)
    location.revision = 0
    failing = false
    await store.journalIdle()
    expect(locate).toHaveBeenCalledTimes(1)
    expect(newId).toHaveBeenCalledTimes(1)
    expect(journal.records.get('first-id')).toMatchObject({
      savedBasename: 'a.md',
      folderIdSha256: 'f'.repeat(64),
      revision: 12,
      ownerKey: '7:42'
    })
  })

  it.each([
    ['meeting', 'newId'],
    ['path', 'newId'],
    ['complete', 'newId'],
    ['meeting', 'now'],
    ['path', 'now'],
    ['complete', 'now']
  ] as const)('never resurrects %s cleanup after a %s construction failure', async (cleanup, boundary) => {
    const journal = memoryJournal()
    const failure = new Error('construction failed')
    let failing = true
    let captured!: TranscriptSaveReceipt
    const store = new TranscriptSaveReceiptStore(256, {
      journal,
      locate: () => ({ savedBasename: 'a.md', folderIdSha256: 'f'.repeat(64), revision: 3 }),
      newId: () => {
        if (failing && boundary === 'newId') throw failure
        return 'pending'
      },
      now: () => {
        if (failing && boundary === 'now') throw failure
        return 1000
      }
    })
    await expect(
      store.run(key(1), owner(42), async (receipt) => {
        captured = receipt
        return durable(42)(receipt)
      })
    ).rejects.toBe(failure)
    if (cleanup === 'meeting') store.markMeetingDiscarded(42, 7)
    else if (cleanup === 'path') store.markDurablePathDiscarded('/m/meeting-42.md', 7)
    else captured.completed.add('complete')
    failing = false
    captured.completed.add('audit')
    captured.deferredIngest = true
    await store.journalIdle()
    await store.journalIdle()
    expect(journal.records.size).toBe(0)
    // An assigned ID may require removal, but no pending construction may ever put a record.
    expect(journal.writes).toBe(boundary === 'now' ? 1 : 0)
  })

  it('keeps each barrier bound to its failed drain while another caller retries', async () => {
    const journal = memoryJournal()
    let attempts = 0
    let release!: () => void
    const heldRetry = new Promise<void>((resolve) => (release = resolve))
    journal.put = async () => {
      if (++attempts === 1) throw new Error('first write failed')
      await heldRetry
    }
    let retry: Promise<void> | undefined
    let barrier: Promise<string> | undefined
    const store = new TranscriptSaveReceiptStore(256, {
      journal,
      locate: () => ({ savedBasename: 'a.md', folderIdSha256: 'f'.repeat(64), revision: 3 }),
      newId: () => 'race',
      onError: () => queueMicrotask(() => (retry = store.journalIdle()))
    })
    const saved = store.run(key(1), owner(42), async (receipt) => {
      await durable(42)(receipt)
      barrier = store.journalIdle().then(
        () => 'resolved',
        () => 'rejected'
      )
      await barrier
      return receipt.durablePath!
    })
    await vi.waitFor(() => expect(attempts).toBe(2))
    await expect(barrier).resolves.toBe('rejected')
    release()
    await retry
    await saved
  })
  it('keeps the saved revision after draft cleanup closes the live store', async () => {
    const journal = memoryJournal()
    let revision = 12
    const store = new TranscriptSaveReceiptStore(256, {
      journal,
      locate: () => ({ savedBasename: 'a.md', folderIdSha256: 'f'.repeat(64), revision }),
      newId: () => 'fixed'
    })
    await store.run(key(1), owner(42), async (receipt) => {
      await durable(42)(receipt)
      await store.journalIdle()
      revision = 0
      receipt.completed.add('draft-cleanup')
      await store.journalIdle()
      return receipt.durablePath!
    })
    expect(journal.records.get('fixed')?.revision).toBe(12)
  })
  it('caps receipts at 256', async () => {
    const store = new TranscriptSaveReceiptStore()
    for (let i = 0; i < 256; i++) await store.run(key(i), owner(i + 1), durable(i + 1, ['complete']))
    // The 257th evicts the least recently touched completed receipt instead of growing.
    await store.run(key(256), owner(999), durable(999, ['complete']))
    let reran = false
    await store.run(key(0), owner(1), async () => {
      reran = true
      return 'again'
    })
    expect(reran).toBe(true)
  })

  it('never evicts pending or incomplete durable entries', async () => {
    const store = new TranscriptSaveReceiptStore(2)
    let release!: () => void
    const pending = store.run(key(1), owner(1), async () => new Promise<string>((r) => (release = () => r('p'))))
    await expect(store.run(key(2), owner(2), durable(2, ['summary-credit']))).resolves.toBe('/m/meeting-2.md')
    expect(() => store.run(key(3), owner(3), durable(3, ['complete']))).toThrow(/capacity/)
    release()
    await pending
    // The incomplete durable receipt resumes against its first file rather than starting over.
    const resumed = vi.fn(async (receipt: any) => receipt.durablePath)
    await expect(store.run(key(2), owner(2), resumed)).resolves.toBe('/m/meeting-2.md')
    expect(resumed.mock.calls[0][0].completed.has('summary-credit')).toBe(true)
  })

  it('fails closed for new saves when capacity is occupied', async () => {
    const store = new TranscriptSaveReceiptStore(1)
    const hang = store.run(key(1), owner(1), () => new Promise<string>(() => {}))
    // Synchronous, so the async IPC handler rejects before any write starts.
    expect(() => store.run(key(2), owner(2), durable(2))).toThrow(/capacity is occupied/)
    void hang
  })

  it('fences a discarded owner against stale retries', async () => {
    const store = new TranscriptSaveReceiptStore()
    await store.run(key(1), owner(5), durable(5, ['summary-credit']))
    store.markMeetingDiscarded(5, 7)
    const work = vi.fn(durable(5))
    await expect(store.run(key(1), owner(5), work)).rejects.toThrow(/discarded/)
    await expect(store.run(key(9), owner(5), work)).rejects.toThrow(/discarded/)
    expect(work).not.toHaveBeenCalled()
  })

  it('journals the durable write and every stage, then removes the record once complete', async () => {
    const { store, journal } = journaled()
    let resume!: () => void
    const gate = new Promise<void>((r) => (resume = r))
    const save = store.run(key(1), owner(1_700), async (receipt) => {
      await durable(1_700, ['summary-credit', 'time-saved-credit', 'draft-cleanup'])(receipt)
      await gate
      receipt.deferredIngest = true
      for (const stage of ['audit', 'rebuild', 'ingest'] as const) receipt.completed.add(stage)
      return receipt.durablePath!
    })
    await vi.waitFor(() => expect(journal.records.size).toBe(1))
    await store.journalIdle()
    const [mid] = journal.records.values()
    expect(mid).toEqual({
      receiptId: 'rec-1',
      ownerKey: '7:1700',
      authGeneration: 7,
      meetingStartedAt: 1_700,
      payloadSha256: key(1).slice(2),
      revision: 4,
      stages: {
        draftSealed: true,
        savedWritten: true,
        brainIngestQueued: false,
        draftsUnlinked: true,
        receiptsDeleted: false
      },
      completed: ['summary-credit', 'time-saved-credit', 'draft-cleanup'],
      savedBasename: 'meeting-1700.md',
      folderIdSha256: 'f'.repeat(64),
      updatedAt: 1000
    })
    resume()
    await save
    await store.journalIdle()
    expect([...journal.records.values()][0]).toMatchObject({
      completed: ['summary-credit', 'time-saved-credit', 'draft-cleanup', 'audit', 'rebuild', 'ingest'],
      deferredIngest: true,
      stages: { brainIngestQueued: true }
    })
    // Coalesced: one write per drain, not one per stage.
    expect(journal.writes).toBeLessThan(8)
    await store.run(key(1), owner(1_700), async (receipt) => {
      receipt.completed.add('speaker-save')
      receipt.completed.add('complete')
      return receipt.durablePath!
    })
    await store.journalIdle()
    expect(journal.records.size).toBe(0)
  })

  it('writes nothing before the durable write, and forgets a discarded meeting', async () => {
    const { store, journal } = journaled()
    await expect(
      store.run(key(1), owner(10), async (receipt) => {
        receipt.normalizedStartedAt = 10
        receipt.settings = settings
        throw new Error('disk full')
      })
    ).rejects.toThrow('disk full')
    await store.journalIdle()
    expect(journal.writes).toBe(0)
    await store.run(key(2), owner(11), durable(11, ['summary-credit']))
    await store.journalIdle()
    expect(journal.records.size).toBe(1)
    store.markMeetingDiscarded(11, 7)
    await store.journalIdle()
    expect(journal.records.size).toBe(0)
    await store.run(key(3), owner(12), durable(12, ['summary-credit']))
    await store.journalIdle()
    store.markDurablePathDiscarded('/m/meeting-12.md', 7)
    await store.journalIdle()
    expect(journal.records.size).toBe(0)
  })

  it('a failing journal prevents success and retains the write for retry', async () => {
    const journal = memoryJournal()
    const put = journal.put
    let fail = true
    journal.put = async () => {
      if (fail) throw new Error('EIO')
    }
    const onError = vi.fn()
    const store = new TranscriptSaveReceiptStore(256, {
      journal,
      locate: () => ({ savedBasename: 'a.md', folderIdSha256: 'f'.repeat(64), revision: 0 }),
      newId: () => 'x',
      onError
    })
    await expect(store.run(key(1), owner(1), durable(1, ['summary-credit']))).rejects.toThrow('EIO')
    await expect(store.journalIdle()).rejects.toThrow('EIO')
    expect(onError).toHaveBeenCalled()
    fail = false
    journal.put = put
    await store.journalIdle()
    expect([...journal.records.values()][0].completed).toEqual(['summary-credit'])
  })

  it('does not journal a save it cannot name safely', async () => {
    const journal = memoryJournal()
    const store = new TranscriptSaveReceiptStore(256, { journal, locate: () => null, newId: () => 'x' })
    await store.run(key(1), owner(1), durable(1, ['summary-credit']))
    await store.journalIdle()
    expect(journal.writes).toBe(0)
  })
})
