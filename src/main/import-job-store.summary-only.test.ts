import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Settings, TranscriptLine } from '@shared/ipc'
import { ImportJobManager, type ImportJob } from './import-jobs'
import { EncryptedImportJobStore } from './import-job-store'
import * as transcripts from './transcripts'

const asyncFsProbe = vi.hoisted(() => ({
  openPaths: [] as string[],
  readFilePaths: [] as string[],
  afterLstat: null as ((path: string) => void) | null
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      asyncFsProbe.openPaths.push(String(args[0]))
      const handle = await actual.open(...args)
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === 'readFile') {
            return (...readArgs: Parameters<typeof target.readFile>) => {
              asyncFsProbe.readFilePaths.push(String(args[0]))
              return target.readFile(...readArgs)
            }
          }
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const stat = await actual.lstat(...args)
      asyncFsProbe.afterLstat?.(String(args[0]))
      return stat
    }
  }
})

const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'metis-import-retention-'))
  roots.push(root)
  return root
}

function settings(summaryOnly: boolean): Settings {
  return {
    encryptTranscripts: false,
    enterpriseLive: { managed: true, inferenceMode: 'cloud-only', summaryOnly }
  } as Settings
}

function savedJob(jobId: string = randomUUID()): ImportJob {
  const lines: TranscriptLine[] = [{ speaker: 'you', text: 'private checkpoint sentinel', t: 1_700_000_000_000 }]
  return {
    jobId,
    sourcePath: '/private/interview.wav',
    sourceName: 'interview.wav',
    sourceSizeBytes: 1234,
    sourceMtimeMs: 1_700_000_000_000,
    title: 'Interview',
    state: 'failed',
    cursor: 3,
    totalChunks: 9,
    lines,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_100
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  asyncFsProbe.openPaths = []
  asyncFsProbe.readFilePaths = []
  asyncFsProbe.afterLstat = null
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('summary-only import checkpoint holds', () => {
  it('keeps legacy 32-hex checkpoints eligible for explicit resume and scoped removal', async () => {
    const root = join(makeRoot(), 'import-jobs')
    const store = new EncryptedImportJobStore(() => settings(false), root)
    const job = savedJob('0123456789abcdef0123456789abcdef')
    await store.save(job)

    await expect(store.markExistingJobsHeld('restart')).resolves.toMatchObject({
      jobIds: [job.jobId],
      inventoryOverflow: false
    })
    await expect(store.loadHeld(job.jobId, true)).resolves.toMatchObject({
      jobId: job.jobId,
      sourcePath: job.sourcePath,
      lines: job.lines
    })
    await expect(store.loadHeld('A'.repeat(32), true)).rejects.toThrow(/Invalid import identity/)
    await expect(store.remove('../0123456789abcdef0123456789abcdef')).rejects.toThrow(/Invalid import identity/)

    await store.remove(job.jobId)
    await expect(store.loadHeld(job.jobId, true)).resolves.toBeUndefined()
  })

  it('persists a manager-generated UUID through the production encrypted store', async () => {
    const root = join(makeRoot(), 'import-jobs')
    const store = new EncryptedImportJobStore(() => settings(false), root)
    const manager = new ImportJobManager({
      store,
      decode: vi.fn(),
      transcribe: vi.fn(async () => 'recognized speech'),
      saveMeeting: vi.fn(async () => 'saved-import.md'),
      enqueueIngest: vi.fn(),
      generateRecap: vi.fn(async () => undefined),
      updateRecap: vi.fn(async () => undefined)
    })

    const job = await manager.start({
      path: '/private/interview.wav',
      name: 'interview.wav',
      sizeBytes: 1_234,
      mtimeMs: 1_700_000_000_000
    })

    expect(job.jobId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    await expect(store.list()).resolves.toEqual([expect.objectContaining({ jobId: job.jobId })])
  })

  it('refuses a new checkpoint before creating the import-jobs root', async () => {
    let current = settings(true)
    const root = join(makeRoot(), 'import-jobs')
    const store = new EncryptedImportJobStore(() => current, root)

    await expect(store.save(savedJob())).rejects.toThrow(/summary-only/i)

    expect(() => readdirSync(root)).toThrow()
  })

  it('marks existing checkpoints by filename without reading or rewriting their bytes', async () => {
    let current = settings(false)
    const root = join(makeRoot(), 'import-jobs')
    const store = new EncryptedImportJobStore(() => current, root)
    const job = savedJob()
    await store.save(job)
    const checkpointPath = join(root, `job-${job.jobId}.json`)
    const before = readFileSync(checkpointPath)
    const readSpy = vi.spyOn(transcripts, 'readSavedFile')
    asyncFsProbe.openPaths = []
    current = settings(true)

    await expect(store.markExistingJobsHeld()).resolves.toEqual({
      jobIds: [job.jobId],
      policyHeldJobIds: [job.jobId],
      inventoryOverflow: false,
      policyHoldOverflow: false
    })

    expect(readSpy).not.toHaveBeenCalled()
    expect(asyncFsProbe.openPaths).not.toContain(checkpointPath)
    expect(readFileSync(checkpointPath)).toEqual(before)
    const heldId = join(root, `job-${job.jobId}.hold.json`)
    const marker = readFileSync(heldId, 'utf8')
    expect(Buffer.byteLength(marker)).toBeLessThanOrEqual(256)
    expect(marker).not.toContain(job.sourcePath)
    expect(marker).not.toContain('private checkpoint sentinel')
    expect(marker).not.toContain(job.sourceName)
  })

  it('does not recover held bytes after policy restoration; only targeted load and marker clear release them', async () => {
    let current = settings(false)
    const root = join(makeRoot(), 'import-jobs')
    const store = new EncryptedImportJobStore(() => current, root)
    const job = savedJob()
    await store.save(job)
    current = settings(true)
    await store.markExistingJobsHeld()
    current = settings(false)

    await expect(store.list()).resolves.toEqual([])
    await expect(store.listHeldJobIds()).resolves.toEqual({
      jobIds: [job.jobId],
      policyHeldJobIds: [job.jobId],
      inventoryOverflow: false,
      policyHoldOverflow: false
    })
    await expect(store.loadHeld(job.jobId)).resolves.toMatchObject({
      jobId: job.jobId,
      cursor: 3,
      lines: [{ text: 'private checkpoint sentinel' }]
    })
    await store.clearHold(job.jobId)

    await expect(store.list()).resolves.toMatchObject([{ jobId: job.jobId, cursor: 3 }])
  })

  it('rechecks policy after path validation and refuses before opening a held checkpoint', async () => {
    let current = settings(false)
    const root = join(makeRoot(), 'import-jobs')
    const store = new EncryptedImportJobStore(() => current, root)
    const job = savedJob()
    await store.save(job)
    await store.markExistingJobsHeld('restart')
    const checkpointPath = join(root, `job-${job.jobId}.json`)
    asyncFsProbe.openPaths = []
    asyncFsProbe.afterLstat = (path) => {
      if (path === checkpointPath) current = settings(true)
    }

    await expect(store.loadHeld(job.jobId, true)).rejects.toThrow(/summary-only/i)

    expect(asyncFsProbe.openPaths).not.toContain(checkpointPath)
  })

  it('rechecks policy after opening and validating the checkpoint but before reading its payload', async () => {
    let current = settings(false)
    const root = join(makeRoot(), 'import-jobs')
    const store = new EncryptedImportJobStore(() => current, root)
    const job = savedJob()
    await store.save(job)
    await store.markExistingJobsHeld('restart')
    const checkpointPath = join(root, `job-${job.jobId}.json`)
    asyncFsProbe.openPaths = []
    asyncFsProbe.readFilePaths = []
    asyncFsProbe.afterLstat = (path) => {
      if (path === checkpointPath && asyncFsProbe.openPaths.includes(checkpointPath)) current = settings(true)
    }

    await expect(store.loadHeld(job.jobId, true)).rejects.toThrow(/summary-only/i)

    expect(asyncFsProbe.openPaths).toContain(checkpointPath)
    expect(asyncFsProbe.readFilePaths).not.toContain(checkpointPath)
  })

  it('fails closed on a mismatched or oversized hold marker and never lists its checkpoint for recovery', async () => {
    const root = join(makeRoot(), 'import-jobs')
    const store = new EncryptedImportJobStore(() => settings(false), root)
    const job = savedJob()
    await store.save(job)
    const checkpointPath = join(root, `job-${job.jobId}.json`)
    const checkpointBefore = readFileSync(checkpointPath)
    const markerPath = join(root, `job-${job.jobId}.hold.json`)
    writeFileSync(markerPath, JSON.stringify({ version: 1, jobId: randomUUID() }), 'utf8')
    const mismatchedMarkerBefore = readFileSync(markerPath)

    await expect(store.list()).resolves.toEqual([])
    asyncFsProbe.openPaths = []
    asyncFsProbe.readFilePaths = []
    await expect(store.loadHeld(job.jobId)).resolves.toBeUndefined()
    expect(asyncFsProbe.openPaths).not.toContain(checkpointPath)
    expect(asyncFsProbe.readFilePaths).not.toContain(checkpointPath)
    expect(readFileSync(checkpointPath)).toEqual(checkpointBefore)
    expect(readFileSync(markerPath)).toEqual(mismatchedMarkerBefore)

    writeFileSync(markerPath, 'x'.repeat(257), 'utf8')
    const oversizedMarkerBefore = readFileSync(markerPath)
    await expect(store.list()).resolves.toEqual([])
    asyncFsProbe.openPaths = []
    asyncFsProbe.readFilePaths = []
    await expect(store.loadHeld(job.jobId)).resolves.toBeUndefined()
    expect(asyncFsProbe.openPaths).not.toContain(checkpointPath)
    expect(asyncFsProbe.readFilePaths).not.toContain(checkpointPath)
    expect(readFileSync(checkpointPath)).toEqual(checkpointBefore)
    expect(readFileSync(markerPath)).toEqual(oversizedMarkerBefore)
  })

  it('does not open nonregular hold or global markers while building the bounded inventory', async () => {
    const root = join(makeRoot(), 'import-jobs')
    const store = new EncryptedImportJobStore(() => settings(false), root)
    const jobId = randomUUID()
    mkdirSync(root)
    mkdirSync(join(root, `job-${jobId}.hold.json`))
    mkdirSync(join(root, 'summary-only-hold-all.json'))
    asyncFsProbe.openPaths = []

    await expect(store.listHeldJobIds()).resolves.toMatchObject({
      jobIds: [],
      inventoryOverflow: true
    })

    expect(asyncFsProbe.openPaths).toEqual([])
  })

  it('preserves the last committed checkpoint when policy changes during the temporary write', async () => {
    let current = settings(false)
    const root = join(makeRoot(), 'import-jobs')
    const store = new EncryptedImportJobStore(() => current, root)
    const job = savedJob()
    await store.save(job)
    const checkpointPath = join(root, `job-${job.jobId}.json`)
    const before = readFileSync(checkpointPath)

    const pending = store.save({
      ...job,
      cursor: 4,
      lines: [...job.lines, { speaker: 'you', text: 'must not commit', t: 2 }]
    })
    current = settings(true)
    await expect(pending).rejects.toThrow(/summary-only/i)

    expect(readFileSync(checkpointPath)).toEqual(before)
    expect(readdirSync(root).some((name) => name.endsWith('.tmp'))).toBe(false)
  })

  it('keeps recovery blocked when an explicit marker clear fails', async () => {
    let current = settings(false)
    const root = join(makeRoot(), 'import-jobs')
    const store = new EncryptedImportJobStore(() => current, root)
    const job = savedJob()
    await store.save(job)
    await store.markExistingJobsHeld()
    current = settings(false)
    const markerPath = join(root, `job-${job.jobId}.hold.json`)
    rmSync(markerPath)
    // A directory at the owned marker name makes unlink fail without changing the checkpoint.
    const { mkdirSync } = await import('node:fs')
    mkdirSync(markerPath)

    await expect(store.clearHold(job.jobId)).rejects.toThrow()
    await expect(store.list()).resolves.toEqual([])
    expect(readFileSync(join(root, `job-${job.jobId}.json`))).toBeTruthy()
  })

  it('keeps the discovered ID when a hold-marker write fails and repairs the marker before explicit Resume', async () => {
    let current = settings(false)
    const root = join(makeRoot(), 'import-jobs')
    const store = new EncryptedImportJobStore(() => current, root)
    const job = savedJob()
    await store.save(job)
    const checkpointPath = join(root, `job-${job.jobId}.json`)
    const checkpointBefore = readFileSync(checkpointPath)
    current = settings(true)
    const readSpy = vi.spyOn(transcripts, 'readSavedFile')

    const originalWrite = transcripts.writeSaved
    const write = vi.spyOn(transcripts, 'writeSaved')
    write.mockImplementation(async (path, content, encrypt, beforeReplace) => {
      if (path.endsWith(`job-${job.jobId}.hold.json`)) throw new Error('hold marker write failed')
      await originalWrite(path, content, encrypt, beforeReplace)
    })
    await expect(store.markExistingJobsHeld()).resolves.toMatchObject({
      jobIds: [job.jobId],
      policyHeldJobIds: [job.jobId],
      inventoryOverflow: true,
      policyHoldOverflow: true
    })
    expect(readFileSync(checkpointPath)).toEqual(checkpointBefore)
    expect(readFileSync(join(root, 'summary-only-hold-all.json'), 'utf8')).toContain('policy')
    expect(readSpy).not.toHaveBeenCalled()

    current = settings(false)
    write.mockRestore()
    const restartedStore = new EncryptedImportJobStore(() => current, root)
    asyncFsProbe.openPaths = []
    asyncFsProbe.readFilePaths = []
    await expect(restartedStore.loadHeld(job.jobId)).resolves.toBeUndefined()
    expect(asyncFsProbe.openPaths).not.toContain(checkpointPath)
    expect(asyncFsProbe.readFilePaths).not.toContain(checkpointPath)

    await expect(restartedStore.markExistingJobsHeld('restart')).resolves.toMatchObject({
      jobIds: [job.jobId],
      policyHeldJobIds: [job.jobId],
      inventoryOverflow: false
    })
    await expect(restartedStore.list()).resolves.toEqual([])
    await expect(restartedStore.loadHeld(job.jobId)).resolves.toMatchObject({
      jobId: job.jobId,
      cursor: 3,
      lines: [{ text: 'private checkpoint sentinel' }]
    })
    await expect(restartedStore.loadHeld(job.jobId, true)).resolves.toMatchObject({ jobId: job.jobId, cursor: 3 })
    expect(readFileSync(checkpointPath)).toEqual(checkpointBefore)
  })

  it('caps summary-only discovery at 1024 job IDs and fences every checkpoint on overflow', async () => {
    const root = join(makeRoot(), 'import-jobs')
    const store = new EncryptedImportJobStore(() => settings(true), root)
    const ids = Array.from({ length: 1025 }, () => randomUUID())
    mkdirSync(root)
    for (const id of ids) writeFileSync(join(root, `job-${id}.json`), 'opaque-old-checkpoint', 'utf8')

    const inventory = await store.markExistingJobsHeld()

    expect(inventory.jobIds).toHaveLength(1024)
    expect(inventory.inventoryOverflow).toBe(true)
    expect(readFileSync(join(root, 'summary-only-hold-all.json'), 'utf8')).toBe(
      JSON.stringify({ version: 1, state: 'overflow', reason: 'policy' })
    )
    await expect(store.list()).resolves.toEqual([])
    // 1,025 real files: a cold hosted Windows runner (Defender scanning each write) needs more than 30 s.
  }, 120_000)
})
