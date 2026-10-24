import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReceiptJournalPort, SaveReceiptRecord } from '../../infra/storage/transcript-receipt-journal'
import { configureErasureFence, createErasureFence, erasureFenceFile } from '../../memory-partition/erasure-fence'
import { resumeJournaledSaves, type ResumeDeps } from './transcript-save-resume'

const ERASED_AT = Date.UTC(2026, 9, 24, 12, 0, 0)
const dirs: string[] = []
afterEach(() => {
  configureErasureFence(null)
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

function record(meetingStartedAt: number): SaveReceiptRecord {
  return {
    receiptId: 'receipt-1',
    ownerKey: 'owner',
    authGeneration: 1,
    meetingStartedAt,
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
    savedBasename: '2026-10-24_100000-planning.md',
    folderIdSha256: 'b'.repeat(64),
    updatedAt: 1
  }
}

async function replay(meetingStartedAt: number) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'synthetic-resume-')))
  dirs.push(dir)
  const fence = createErasureFence(erasureFenceFile(dir))
  await fence.record('legacy', 'c'.repeat(32), ERASED_AT)
  configureErasureFence(fence)
  const journal: ReceiptJournalPort = {
    load: vi.fn(async () => ({ ok: true as const, records: [record(meetingStartedAt)] })),
    put: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined)
  }
  const stages = {
    'draft-cleanup': vi.fn(async () => undefined),
    rebuild: vi.fn(async () => undefined),
    ingest: vi.fn(async () => undefined)
  }
  const deps: ResumeDeps = {
    journal,
    folder: { join: (n) => n, idSha256: 'b'.repeat(64), verifySavedIdentity: vi.fn(async () => 'match' as const) },
    stages,
    deferredDefault: false,
    now: () => 2
  }
  return { outcome: await resumeJournaledSaves(deps), journal, stages }
}

describe('save receipt replay after an erasure (G82)', () => {
  it('receipt replay re-ingests nothing', async () => {
    const { outcome, journal, stages } = await replay(ERASED_AT - 3_600_000)
    expect(outcome).toMatchObject({ dropped: 1, finished: 0 })
    expect(stages.ingest).not.toHaveBeenCalled()
    expect(stages.rebuild).not.toHaveBeenCalled()
    expect(stages['draft-cleanup']).not.toHaveBeenCalled()
    expect(journal.remove).toHaveBeenCalledWith('receipt-1')
  })

  it('a receipt for a meeting recorded after the erasure still resumes', async () => {
    const { outcome, stages } = await replay(ERASED_AT + 3_600_000)
    expect(outcome.dropped).toBe(0)
    expect(stages.ingest).toHaveBeenCalled()
  })
})
