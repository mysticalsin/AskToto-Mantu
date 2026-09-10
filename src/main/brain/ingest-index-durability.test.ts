import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Settings } from '@shared/ipc'
import * as store from './store'
import { updateIndex, whenIndexWritesSettle } from './ingest'

vi.mock('electron')
vi.mock('./store', async (original) => {
  const actual = await original<typeof import('./store')>()
  return { ...actual, writeIndex: vi.fn(actual.writeIndex) }
})

describe('index mutations own their unpublished snapshot', () => {
  let folder: string
  let settings: Settings

  beforeEach(async () => {
    folder = mkdtempSync(join(tmpdir(), 'metis-index-durability-'))
    vi.stubEnv('ASKTOTO_USERDATA', folder)
    settings = { meetingsFolder: folder, encryptTranscripts: false } as Settings
    await store.writeIndex(settings, store.readIndex(settings))
  })

  afterEach(async () => {
    await whenIndexWritesSettle()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    rmSync(folder, { recursive: true, force: true })
  })

  it('does not poison cached state or a later successful write when persistence fails', async () => {
    const before = store.readIndex(settings)
    vi.mocked(store.writeIndex).mockRejectedValueOnce(new Error('synthetic disk failure'))

    await expect(updateIndex(settings, (index) => {
      index.ingested['not-saved.md'] = { at: 1, ok: true }
      index.revision += 1
    })).rejects.toThrow('synthetic disk failure')

    expect(before.ingested).toEqual({})
    expect(store.readIndex(settings).ingested).toEqual({})
    await updateIndex(settings, (index) => {
      index.ingested['saved.md'] = { at: 2, ok: true }
      index.revision += 1
    })
    const disk = JSON.parse(readFileSync(join(store.brainDir(settings), 'index.json'), 'utf8'))
    expect(Object.keys(disk.ingested)).toEqual(['saved.md'])
    expect(disk.revision).toBe(1)
  })

  it('keeps existing readers unchanged when a successful mutation publishes a new index', async () => {
    const before = store.readIndex(settings)
    await updateIndex(settings, (index) => {
      index.ingested['saved.md'] = { at: 2, ok: true }
    })
    expect(before.ingested).toEqual({})
    expect(store.readIndex(settings).ingested['saved.md']?.ok).toBe(true)
  })

  it('discards partial mutation if the mutator throws and keeps the serial lane usable', async () => {
    await expect(updateIndex(settings, (index) => {
      index.ingested['not-saved.md'] = { at: 1, ok: true }
      throw new Error('synthetic mutator failure')
    })).rejects.toThrow('synthetic mutator failure')
    expect(store.readIndex(settings).ingested).toEqual({})
    await updateIndex(settings, (index) => { index.revision += 1 })
    expect(store.readIndex(settings).revision).toBe(1)
    expect(store.readIndex(settings).ingested).toEqual({})
  })
})
