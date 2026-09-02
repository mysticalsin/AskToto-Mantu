import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const electron = vi.hoisted(() => ({ app: { isPackaged: true } }))
const network = vi.hoisted(() => ({ httpsGet: vi.fn(), execFile: vi.fn() }))

vi.mock('electron', () => electron)
vi.mock('node:https', () => ({ get: network.httpsGet }))
vi.mock('node:child_process', () => ({ execFile: network.execFile }))
vi.mock('./logger', () => ({ mainLog: { error: vi.fn() } }))

import { ensureParakeetModel, parakeetModelReady } from './parakeet'

describe('bundled Parakeet runtime', () => {
  let resourcesPath: string
  let originalResourcesPath: PropertyDescriptor | undefined

  beforeEach(() => {
    resourcesPath = mkdtempSync(join(tmpdir(), 'metis-parakeet-test-'))
    originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: resourcesPath })
    network.httpsGet.mockClear()
    network.execFile.mockClear()
  })

  afterEach(() => {
    rmSync(resourcesPath, { recursive: true, force: true })
    if (originalResourcesPath) Object.defineProperty(process, 'resourcesPath', originalResourcesPath)
    else delete (process as unknown as { resourcesPath?: string }).resourcesPath
    vi.unstubAllGlobals()
  })

  it('fails locally with reinstall guidance when packaged assets are missing and performs no network/bootstrap work', async () => {
    const fetchSpy = vi.fn()
    const progressSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    expect(parakeetModelReady()).toBe(false)
    await expect(ensureParakeetModel(progressSpy)).rejects.toThrow(/Reinstall Métis/)

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(network.httpsGet).not.toHaveBeenCalled()
    expect(network.execFile).not.toHaveBeenCalled()
    expect(progressSpy).not.toHaveBeenCalled()
    expect(readdirSync(resourcesPath)).toEqual([])
  })

  it('keeps the production module free of downloader and extractor dependencies', () => {
    const source = readFileSync(join(__dirname, 'parakeet.ts'), 'utf8')
    expect(source).not.toMatch(/node:https|node:http|createWriteStream|execFile|MODEL_URL/)
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
