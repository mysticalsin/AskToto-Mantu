import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const paths = vi.hoisted(() => ({ resources: '', userData: '' }))

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => paths.userData
  },
  net: { fetch: vi.fn() }
}))
vi.mock('./logger', () => ({ mainLog: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))

import {
  ASR_ASSETS_MISSING,
  PARAKEET_REQUIRED_FILES,
  WHISPER_FLOOR_ID,
  WHISPER_FLOOR_REQUIRED_FILES,
  ensureImportAsrAssets,
  importAsrAssetsReady,
  parakeetFilesReady,
  setAsrEnsureTestHooks,
  whisperFloorReady
} from './asr-bundled-ensure'

describe('asr-bundled-ensure', () => {
  let originalResourcesPath: PropertyDescriptor | undefined

  beforeEach(() => {
    paths.resources = mkdtempSync(join(tmpdir(), 'metis-asr-res-'))
    paths.userData = mkdtempSync(join(tmpdir(), 'metis-asr-ud-'))
    originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: paths.resources })
    setAsrEnsureTestHooks(null)
  })

  afterEach(() => {
    setAsrEnsureTestHooks(null)
    rmSync(paths.resources, { recursive: true, force: true })
    rmSync(paths.userData, { recursive: true, force: true })
    if (originalResourcesPath) Object.defineProperty(process, 'resourcesPath', originalResourcesPath)
    else delete (process as unknown as { resourcesPath?: string }).resourcesPath
  })

  it('treats an empty resources dir as not ready and copies via the ensure hooks', async () => {
    expect(importAsrAssetsReady()).toBe(false)
    const progress: number[] = []
    setAsrEnsureTestHooks({
      fetchParakeet: async (dest, onProgress) => {
        mkdirSync(dest, { recursive: true })
        for (const name of PARAKEET_REQUIRED_FILES) writeFileSync(join(dest, name), 'p')
        onProgress?.(100)
      },
      fetchWhisperFloor: async (dest, onProgress) => {
        const dir = join(dest, ...WHISPER_FLOOR_ID.split('/'))
        for (const rel of WHISPER_FLOOR_REQUIRED_FILES) {
          const file = join(dir, rel)
          mkdirSync(join(file, '..'), { recursive: true })
          writeFileSync(file, 'w')
        }
        onProgress?.(100)
      }
    })
    await ensureImportAsrAssets((pct) => progress.push(pct))
    expect(parakeetFilesReady(join(paths.userData, 'asr-models', 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'))).toBe(
      true
    )
    expect(whisperFloorReady(join(paths.userData, 'asr-models'))).toBe(true)
    expect(importAsrAssetsReady()).toBe(true)
    expect(progress.some((n) => n > 0)).toBe(true)
    expect(ASR_ASSETS_MISSING).not.toMatch(/[Rr]einstall/)
  })
})
