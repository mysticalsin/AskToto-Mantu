import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const paths = vi.hoisted(() => ({ resources: '', userData: '' }))
const network = vi.hoisted(() => ({ httpsGet: vi.fn(), execFile: vi.fn(), fetch: vi.fn() }))

vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => paths.userData },
  net: { fetch: (...args: unknown[]) => network.fetch(...args) }
}))
vi.mock('node:https', () => ({ get: network.httpsGet }))
vi.mock('node:child_process', () => ({ execFile: network.execFile }))
vi.mock('./logger', () => ({ mainLog: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))

import { ASR_ASSETS_MISSING, resetAsrEnsureStateForTests } from './asr-bundled-ensure'
import { ensureParakeetModel, parakeetModelReady } from './parakeet'

describe('bundled Parakeet runtime', () => {
  let originalResourcesPath: PropertyDescriptor | undefined

  beforeEach(() => {
    paths.resources = mkdtempSync(join(tmpdir(), 'metis-parakeet-test-'))
    paths.userData = mkdtempSync(join(tmpdir(), 'metis-parakeet-ud-'))
    originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: paths.resources })
    network.httpsGet.mockClear()
    network.execFile.mockClear()
    network.fetch.mockReset()
    resetAsrEnsureStateForTests()
  })

  afterEach(() => {
    rmSync(paths.resources, { recursive: true, force: true })
    rmSync(paths.userData, { recursive: true, force: true })
    if (originalResourcesPath) Object.defineProperty(process, 'resourcesPath', originalResourcesPath)
    else delete (process as unknown as { resourcesPath?: string }).resourcesPath
    vi.unstubAllGlobals()
  })

  it('fails loud when the high-accuracy files are missing and the download cannot complete', async () => {
    network.fetch.mockRejectedValue(new Error('offline'))
    const progressSpy = vi.fn()

    expect(parakeetModelReady()).toBe(false)
    await expect(ensureParakeetModel(progressSpy)).rejects.toThrow(/offline|Could not get the high-accuracy/)
    expect(parakeetModelReady()).toBe(false)
    expect(readdirSync(paths.resources)).toEqual([])
    expect(ASR_ASSETS_MISSING).not.toMatch(/[Rr]einstall/)
  })

  it('keeps the production module free of its own downloader (ensure lives next door)', () => {
    const source = readFileSync(join(__dirname, 'parakeet.ts'), 'utf8')
    expect(source).not.toMatch(/node:https|node:http|createWriteStream|execFile|MODEL_URL/)
    expect(source).toMatch(/ensureParakeetAssets/)
  })
})
