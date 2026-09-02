import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const paths = vi.hoisted(() => ({ resources: '', userData: '' }))
const network = vi.hoisted(() => ({ httpsGet: vi.fn(), execFile: vi.fn(), fetch: vi.fn() }))

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => paths.userData
  },
  net: { fetch: network.fetch }
}))
vi.mock('node:https', () => ({ get: network.httpsGet }))
vi.mock('node:child_process', () => ({ execFile: network.execFile }))
vi.mock('./logger', () => ({ mainLog: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))

import { ensureParakeetModel, parakeetModelReady } from './parakeet'
import { PARAKEET_REQUIRED_FILES, setAsrEnsureTestHooks } from './asr-bundled-ensure'

function writeParakeet(dir: string): void {
  mkdirSync(dir, { recursive: true })
  for (const name of PARAKEET_REQUIRED_FILES) writeFileSync(join(dir, name), 'ok')
}

describe('bundled Parakeet runtime', () => {
  let originalResourcesPath: PropertyDescriptor | undefined

  beforeEach(() => {
    paths.resources = mkdtempSync(join(tmpdir(), 'metis-parakeet-res-'))
    paths.userData = mkdtempSync(join(tmpdir(), 'metis-parakeet-ud-'))
    originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: paths.resources })
    network.httpsGet.mockClear()
    network.execFile.mockClear()
    network.fetch.mockClear()
    setAsrEnsureTestHooks(null)
  })

  afterEach(() => {
    setAsrEnsureTestHooks(null)
    rmSync(paths.resources, { recursive: true, force: true })
    rmSync(paths.userData, { recursive: true, force: true })
    if (originalResourcesPath) Object.defineProperty(process, 'resourcesPath', originalResourcesPath)
    else delete (process as unknown as { resourcesPath?: string }).resourcesPath
    vi.unstubAllGlobals()
  })

  it('missing asr in a fake resources dir no longer produces the reinstall string; ensure fetches into userData', async () => {
    const progressSpy = vi.fn()
    setAsrEnsureTestHooks({
      fetchParakeet: async (dest, onProgress) => {
        writeParakeet(dest)
        onProgress?.(40)
        onProgress?.(100)
      }
    })

    expect(parakeetModelReady()).toBe(false)
    await expect(ensureParakeetModel(progressSpy)).resolves.toBeUndefined()
    expect(parakeetModelReady()).toBe(true)
    expect(progressSpy).toHaveBeenCalled()
    expect(readFileSync(join(__dirname, 'parakeet.ts'), 'utf8')).not.toMatch(/Reinstall Métis/)
    await expect(ensureParakeetModel(progressSpy)).resolves.toBeUndefined()
  })

  it('failed fetch is an honest connection error, never a reinstall demand', async () => {
    setAsrEnsureTestHooks({
      fetchParakeet: async () => {
        throw new Error('network down')
      }
    })
    await expect(ensureParakeetModel()).rejects.toThrow(/network down/)
    try {
      await ensureParakeetModel()
      throw new Error('expected ensure to fail')
    } catch (e) {
      expect(String(e)).not.toMatch(/[Rr]einstall/)
    }
  })

  it('keeps the production module free of downloader and extractor dependencies', () => {
    const source = readFileSync(join(__dirname, 'parakeet.ts'), 'utf8')
    expect(source).not.toMatch(/node:https|node:http|createWriteStream|execFile|MODEL_URL/)
    expect(source).toMatch(/ensureParakeetAssets/)
  })

  it('MQA-285 — ensureParakeetModel constructs the recognizer so first Listen is not a cold sherpa load', () => {
    const source = readFileSync(join(__dirname, 'parakeet.ts'), 'utf8')
    const fn = source.slice(
      source.indexOf('export async function ensureParakeetModel'),
      source.indexOf('function getRecognizer')
    )
    expect(fn).toMatch(/getRecognizer\(\)/)
  })
})
