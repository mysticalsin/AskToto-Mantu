import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const paths = vi.hoisted(() => ({ resources: '', userData: '', isPackaged: false }))
const network = vi.hoisted(() => ({ httpsGet: vi.fn(), execFile: vi.fn(), fetch: vi.fn() }))

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return paths.isPackaged
    },
    getPath: () => paths.userData
  },
  net: { fetch: network.fetch }
}))
vi.mock('node:https', () => ({ get: network.httpsGet }))
vi.mock('node:child_process', () => ({ execFile: network.execFile }))
vi.mock('./logger', () => ({ mainLog: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))

import { ensureParakeetModel, parakeetModelReady } from './parakeet'
import { PARAKEET_REQUIRED_FILES, setAsrEnsureTestHooks, type AsrEnsureTestHooks } from './asr-bundled-ensure'

function withTestResources(hooks: Omit<AsrEnsureTestHooks, 'bundledResourceRoot'> = {}): AsrEnsureTestHooks {
  return { ...hooks, bundledResourceRoot: () => paths.resources }
}

function writeParakeet(dir: string): void {
  mkdirSync(dir, { recursive: true })
  for (const name of PARAKEET_REQUIRED_FILES) writeFileSync(join(dir, name), 'ok')
}

describe('bundled Parakeet runtime', () => {
  let originalResourcesPath: PropertyDescriptor | undefined

  beforeEach(() => {
    paths.isPackaged = false
    paths.resources = mkdtempSync(join(tmpdir(), 'metis-parakeet-res-'))
    paths.userData = mkdtempSync(join(tmpdir(), 'metis-parakeet-ud-'))
    originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: paths.resources })
    network.httpsGet.mockClear()
    network.execFile.mockClear()
    network.fetch.mockClear()
    setAsrEnsureTestHooks(withTestResources())
  })

  afterEach(() => {
    setAsrEnsureTestHooks(null)
    rmSync(paths.resources, { recursive: true, force: true })
    rmSync(paths.userData, { recursive: true, force: true })
    if (originalResourcesPath) Object.defineProperty(process, 'resourcesPath', originalResourcesPath)
    else delete (process as unknown as { resourcesPath?: string }).resourcesPath
    vi.unstubAllGlobals()
  })

  it('an unprovisioned development checkout fetches into userData', async () => {
    const progressSpy = vi.fn()
    setAsrEnsureTestHooks(withTestResources({
      fetchParakeet: async (dest, onProgress) => {
        writeParakeet(dest)
        onProgress?.(40)
        onProgress?.(100)
      }
    }))

    expect(parakeetModelReady()).toBe(false)
    await expect(ensureParakeetModel(progressSpy)).resolves.toBeUndefined()
    expect(parakeetModelReady()).toBe(true)
    expect(progressSpy).toHaveBeenCalled()
    await expect(ensureParakeetModel(progressSpy)).resolves.toBeUndefined()
  })

  it('Access login HTML on disk is not a ready Parakeet model', () => {
    const dir = join(paths.userData, 'asr-models', 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8')
    mkdirSync(dir, { recursive: true })
    const html = '<!DOCTYPE html><html><body>cloudflareaccess.com Sign in</body></html>'
    for (const name of PARAKEET_REQUIRED_FILES) writeFileSync(join(dir, name), html)
    expect(parakeetModelReady()).toBe(false)
  })

  it('a development fetch failure stays an honest connection error', async () => {
    setAsrEnsureTestHooks(withTestResources({
      fetchParakeet: async () => {
        throw new Error('network down')
      }
    }))
    await expect(ensureParakeetModel()).rejects.toThrow(/network down/)
  })

  it('keeps the production module free of downloader and extractor dependencies', () => {
    const source = readFileSync(join(__dirname, 'parakeet.ts'), 'utf8')
    expect(source).not.toMatch(/node:https|node:http|createWriteStream|execFile|MODEL_URL/)
    expect(source).toMatch(/ensureParakeetAssets/)
  })
})
