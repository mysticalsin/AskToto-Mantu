import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '@shared/ipc'

const paths = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => paths.userData } }))
vi.mock('../../logger', () => ({
  mainLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  auditLog: vi.fn()
}))
const ingest = vi.hoisted(() => ({ enqueueIngest: vi.fn(async () => undefined) }))
vi.mock('../../brain/ingest', () => ingest)
const graph = vi.hoisted(() => ({ scheduleRebuild: vi.fn(async () => undefined) }))
vi.mock('../../graphify', () => graph)

let root: string
beforeEach(async () => {
  vi.resetModules()
  root = await mkdtemp(join(tmpdir(), 'metis-main-receipts-'))
  paths.userData = join(root, 'userData')
  ingest.enqueueIngest.mockClear()
  graph.scheduleRebuild.mockClear()
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const save = (durablePath: string, settings: Settings) => async (receipt: any) => {
  receipt.normalizedStartedAt = 1_700_000_000_000
  receipt.settings = settings
  receipt.durablePath = durablePath
  for (const stage of ['summary-credit', 'time-saved-credit', 'draft-cleanup', 'audit']) receipt.completed.add(stage)
  return durablePath
}

describe('main transcript save receipts', () => {
  it('journals under userData by basename, and launch recovery resumes rebuild and ingest', async () => {
    const storage = await import('../../infra/storage/meetings-storage')
    storage.useStorageForTests()
    const folder = join(root, 'meetings')
    await mkdir(folder)
    const saved = join(folder, '2023-11-14_221320-planning.md')
    await writeFile(saved, '---\ntype: meeting-transcript\n---\n')
    const settings = { meetingsFolder: folder, brainConsolidation: { enabled: true } } as Settings
    const { createMainTranscriptSaveReceipts } = await import('./main-save-receipts')
    const store = createMainTranscriptSaveReceipts()
    await store.run(`3:${'d'.repeat(64)}`, { startedAt: 1_700_000_000_000, authGeneration: 3 }, save(saved, settings))
    await store.journalIdle()
    const text = await readFile(join(paths.userData, 'transcript-receipts', 'receipts.v1.json'), 'utf8')
    expect(JSON.parse(text).records).toEqual([
      expect.objectContaining({ savedBasename: '2023-11-14_221320-planning.md', revision: 0 })
    ])
    expect(text).not.toContain(root)

    const { recoverOrphanDrafts } = await import('./draft-recovery')
    await recoverOrphanDrafts(settings)
    expect(graph.scheduleRebuild).toHaveBeenCalledOnce()
    // No recorded policy yet, so the current settings' consolidation policy applies.
    expect(ingest.enqueueIngest).toHaveBeenCalledWith(saved, { deferred: true })
    const after = await readFile(join(paths.userData, 'transcript-receipts', 'receipts.v1.json'), 'utf8')
    expect(JSON.parse(after)).toEqual({ schema: 'metis.save-receipts.v1', records: [] })
  })

  it('does not journal a save outside the meetings folder', async () => {
    const settings = { meetingsFolder: join(root, 'meetings') } as Settings
    const { createMainTranscriptSaveReceipts } = await import('./main-save-receipts')
    const store = createMainTranscriptSaveReceipts()
    const outside = save(join(root, 'elsewhere.md'), settings)
    await store.run(`3:${'e'.repeat(64)}`, { startedAt: 5, authGeneration: 3 }, outside)
    await store.journalIdle()
    await expect(readFile(join(paths.userData, 'transcript-receipts', 'receipts.v1.json'), 'utf8')).rejects.toThrow()
  })
})
