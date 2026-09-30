import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import type { Settings } from '@shared/ipc'
import { EncryptedImportJobStore } from './import-job-store'
import type { ImportJob } from './import-jobs'

vi.mock('electron')
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const syncFsBlocked = () => {
    throw new Error('import-job-store must not use sync fs')
  }
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: syncFsBlocked,
      mkdirSync: syncFsBlocked,
      readdirSync: syncFsBlocked,
      statSync: syncFsBlocked,
      readFileSync: syncFsBlocked
    },
    existsSync: syncFsBlocked,
    mkdirSync: syncFsBlocked,
    readdirSync: syncFsBlocked,
    statSync: syncFsBlocked,
    readFileSync: syncFsBlocked
  }
})

const settings = (): Settings => ({ encryptTranscripts: false } as Settings)

const job: ImportJob = {
  jobId: 'abc_123',
  sourcePath: '/recordings/source.wav',
  sourceName: 'source.wav',
  sourceSizeBytes: 123,
  sourceMtimeMs: 1_700_000_000_000,
  title: 'Source',
  state: 'queued',
  cursor: 0,
  totalChunks: 1,
  lines: [],
  createdAt: 1,
  updatedAt: 1
}

describe('EncryptedImportJobStore', () => {
  it('lists valid checkpoints through async fs without sync directory, stat, or file reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'asktoto-import-jobs-'))
    try {
      const store = new EncryptedImportJobStore(settings, root)
      await store.save(job)
      await writeFile(join(root, 'job-bad.json'), '{', 'utf8')
      await writeFile(join(root, 'not-a-job.json'), JSON.stringify(job), 'utf8')
      await mkdir(join(root, 'job-directory.json'))

      await expect(store.list()).resolves.toEqual([job])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('treats missing removals as already removed through async unlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'asktoto-import-jobs-'))
    try {
      const store = new EncryptedImportJobStore(settings, root)
      await expect(store.remove('missing')).resolves.toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
