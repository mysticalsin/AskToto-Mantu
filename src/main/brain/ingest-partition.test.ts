import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Settings } from '@shared/ipc'
import { PersonEntitySchema } from '@shared/brain'
import { configureMemoryPartitions, resetMemoryAccessForTests } from '../memory-partition/memory-access'
import { createMemoryPartitions, type MemoryIdentity } from '../memory-partition/memory-partitions'
import { readModuleSource } from '../../test-helpers/module-source'
import { enqueueJobs, isJobAdmissionOpen, jobPartition, runJobInPartition, type JobHooks } from './ingest-job-hooks'
import { readPerson, writePerson } from './store'

vi.mock('electron')

const key = (c: string): string => c.repeat(64)
const verified = (owner: string): MemoryIdentity => ({
  kind: 'verified',
  scope: { tenantKey: key('1'), ownerKey: key(owner) }
})

/** A brain/ingest job started under one owner must not write into the partition of the owner who signs in later. */
describe('G19: brain jobs are fenced to the partition they started under', () => {
  let folder: string
  let s: Settings
  let identity: MemoryIdentity
  let partitions: ReturnType<typeof createMemoryPartitions>
  let text: string | null

  const switchTo = async (next: MemoryIdentity): Promise<void> => {
    identity = next
    await partitions.activate()
  }
  const person = (name: string) => PersonEntitySchema.parse({ id: 'maria-silva', name })
  const brainRoots = (): string[] => readdirSync(folder).filter((name) => name.startsWith('.brain'))

  beforeEach(async () => {
    folder = mkdtempSync(join(tmpdir(), 'asktoto-g19-job-'))
    s = { meetingsFolder: folder } as Settings
    text = null
    identity = verified('a')
    partitions = createMemoryPartitions({
      source: { identity: () => identity },
      ledger: {
        read: async () => text,
        write: async (next) => {
          text = next
        }
      },
      legacyOwnerHint: async () => null
    })
    configureMemoryPartitions(partitions)
    await partitions.activate()
  })
  afterEach(() => {
    resetMemoryAccessForTests()
    rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  it('a queued job is stamped with the partition in force and stays open only while it is', async () => {
    const queue: JobHooks[] = []
    const job: JobHooks = {}
    enqueueJobs(queue, [job])
    expect(queue).toEqual([job])
    expect(jobPartition(job)).toBe('legacy')
    expect(isJobAdmissionOpen(job)).toBe(true)
    await switchTo(verified('b'))
    expect(isJobAdmissionOpen(job)).toBe(false)
    await switchTo(verified('a'))
    expect(isJobAdmissionOpen(job)).toBe(true)
  })

  it('a job queued while no partition was open never opens', async () => {
    identity = { kind: 'signed-out' }
    const job: JobHooks = {}
    enqueueJobs([], [job])
    expect(jobPartition(job)).toBeNull()
    await switchTo(verified('a'))
    expect(isJobAdmissionOpen(job)).toBe(false)
  })

  it('a job without a stamp (admission not partition-bound) is unaffected', () => {
    expect(isJobAdmissionOpen({})).toBe(true)
  })

  it('a write by a job that started under A is refused after a switch to B, and B’s partition stays empty', async () => {
    const job: JobHooks = {}
    enqueueJobs([], [job])
    await switchTo(verified('b'))
    await expect(runJobInPartition(job, () => writePerson(s, 'maria-silva', person('From A')))).rejects.toMatchObject({
      name: 'MemoryClosedError',
      status: 'stale'
    })
    expect(readPerson(s, 'maria-silva')).toBeNull()
    expect(brainRoots().every((name) => name === '.brain' || name.startsWith('.brain-p-'))).toBe(true)
    // B's own work is not refused, and A's job writes again once A is back.
    await writePerson(s, 'maria-silva', person('From B'))
    expect(readPerson(s, 'maria-silva')?.name).toBe('From B')
    await switchTo(verified('a'))
    await runJobInPartition(job, () => writePerson(s, 'maria-silva', person('From A')))
    expect(readPerson(s, 'maria-silva')?.name).toBe('From A')
  })

  it('a switch in the middle of a job fences the writes after it, not only the first', async () => {
    const job: JobHooks = {}
    enqueueJobs([], [job])
    await expect(
      runJobInPartition(job, async () => {
        await writePerson(s, 'maria-silva', person('First'))
        await switchTo(verified('b'))
        await writePerson(s, 'tom-becker', person('Second'))
      })
    ).rejects.toMatchObject({ name: 'MemoryClosedError', status: 'stale' })
    expect(readPerson(s, 'tom-becker')).toBeNull()
  })

  it('both ways a job enters the ingest queue stamp it, and its writes run under that stamp', () => {
    const ingest = readModuleSource(__dirname, './ingest').text.replace(/\r\n/g, '\n')
    expect(ingest).not.toMatch(/queue\.push\(/)
    expect(ingest).toContain('enqueueJobs(queue, [job])')
    expect(ingest).toContain('enqueueJobs(queue, candidates)')
    expect(ingest).toMatch(/runJobInPartition\(result\.job, /)
  })
})
