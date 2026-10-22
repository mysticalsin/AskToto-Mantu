import { mkdir, mkdtemp, readdir, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '@shared/ipc'

const paths = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => paths.userData } }))
const audit = vi.hoisted(() => ({ auditLog: vi.fn() }))
vi.mock('../../logger', () => ({
  mainLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  auditLog: audit.auditLog
}))
vi.mock('../../brain/ingest', () => ({ enqueueIngest: vi.fn(async () => undefined) }))
vi.mock('../../graphify', () => ({ scheduleRebuild: vi.fn(async () => undefined) }))

let root: string
let folder: string
const LONG_AGO = Date.now() / 1000 - 3600
const TEMP = '2026-10-22_000548-f234d45774f6.md.efcb20bf4ecb.tmp'

beforeEach(async () => {
  vi.resetModules()
  audit.auditLog.mockClear()
  root = await realpath(await mkdtemp(join(tmpdir(), 'metis-recovery-sweep-')))
  paths.userData = join(root, 'userData')
  folder = join(root, 'meetings')
  await mkdir(folder)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('launch recovery sweeps orphan atomic-write temps (Q13 / C31 S3)', () => {
  it('removes a stale temp left by a killed save and keeps a fresh one and real meetings', async () => {
    const storage = await import('../../infra/storage/meetings-storage')
    storage.useStorageForTests()
    await writeFile(join(folder, TEMP), 'synthetic-bytes')
    await utimes(join(folder, TEMP), LONG_AGO, LONG_AGO)
    const fresh = '2026-10-22_000549-aaaaaaaaaaaa.md.0123456789ab.tmp'
    await writeFile(join(folder, fresh), 'synthetic-bytes')
    await writeFile(join(folder, 'index.json'), '[]')
    const { recoverOrphanDrafts } = await import('./draft-recovery')
    const result = await recoverOrphanDrafts({ meetingsFolder: folder } as Settings)
    expect(result).toEqual({ recovered: 0 })
    expect((await readdir(folder)).sort()).toEqual([fresh, 'index.json'])
    expect(audit.auditLog).toHaveBeenCalledWith('transcript.temp_swept', { swept: 1, skipped: 1, failed: 0 })
  })
})
