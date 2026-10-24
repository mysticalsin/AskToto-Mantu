import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { finalizeImportJob, type ImportJobPipelineHost } from './import-job-pipelines'
import type { ImportJob } from './import-job-types'
import { configureErasureFence, createErasureFence, erasureFenceFile } from './memory-partition/erasure-fence'

const ERASED_AT = Date.UTC(2026, 9, 24, 12, 0, 0)
const dirs: string[] = []
afterEach(() => {
  configureErasureFence(null)
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

async function fenceAtErasure(): Promise<void> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'synthetic-import-fence-')))
  dirs.push(dir)
  const fence = createErasureFence(erasureFenceFile(dir))
  await fence.record('legacy', 'c'.repeat(32), ERASED_AT)
  configureErasureFence(fence)
}

function harness(createdAt: number) {
  // The recording's own date is old: only the job's enqueue time says whether it predates the erasure.
  const job = {
    jobId: 'job-1',
    title: 'Synthetic',
    lines: [],
    sourceMtimeMs: 1,
    createdAt,
    state: 'saving'
  } as unknown as ImportJob
  const written: string[] = []
  const saveMeeting = vi.fn(async (_meeting: unknown, beforeReplace?: () => void) => {
    beforeReplace?.() // the storage sink's replacement-time guard
    written.push('meeting')
    return 'file.md'
  })
  const host = {
    deps: { saveMeeting, updateRecap: vi.fn(), generateRecap: vi.fn(async () => ''), enqueueIngest: vi.fn() },
    copy: (value: unknown) => value,
    persist: vi.fn(async () => undefined),
    assertRetentionAllowed: () => undefined,
    assertJobWriteAllowed: () => undefined,
    stopIfPolicyHeld: async () => false,
    abandonIfCancelled: async () => false,
    removeCheckpoint: async () => undefined,
    isCurrentJob: () => false,
    activeJobIds: new Set<string>(),
    fail: vi.fn(async () => undefined),
    holdForPolicy: vi.fn(async () => undefined)
  } as unknown as ImportJobPipelineHost
  return { job, host, written }
}

describe('import job meeting write after erasure (G82)', () => {
  it('a job enqueued before the erasure writes no meeting, whatever the recording date', async () => {
    await fenceAtErasure()
    const { job, host, written } = harness(ERASED_AT - 60_000)
    await finalizeImportJob(host, job)
    expect(written).toEqual([])
    expect(host.fail).not.toHaveBeenCalled()
    expect(host.deps.enqueueIngest).not.toHaveBeenCalled()
  })

  it('a job enqueued after the erasure still writes its meeting', async () => {
    await fenceAtErasure()
    const { job, host, written } = harness(ERASED_AT + 60_000)
    await finalizeImportJob(host, job)
    expect(written).toEqual(['meeting'])
  })
})
