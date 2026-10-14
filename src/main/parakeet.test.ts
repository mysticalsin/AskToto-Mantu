import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const paths = vi.hoisted(() => ({ resources: '', userData: '', isPackaged: false }))
const network = vi.hoisted(() => ({ httpsGet: vi.fn(), execFile: vi.fn(), fetch: vi.fn() }))
const nativeHost = vi.hoisted(() => ({ fork: vi.fn() }))
const modelOpenGuard = vi.hoisted(() => ({ active: false, calls: 0 }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      if (modelOpenGuard.active) modelOpenGuard.calls += 1
      return actual.openSync(...args)
    }
  }
})

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return paths.isPackaged
    },
    getPath: () => paths.userData
  },
  net: { fetch: network.fetch },
  utilityProcess: { fork: nativeHost.fork }
}))
vi.mock('node:https', () => ({ get: network.httpsGet }))
vi.mock('node:child_process', () => ({ execFile: network.execFile }))
vi.mock('./logger', () => ({ mainLog: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))

import { ensureParakeetModel, parakeetModelReady, parakeetRelease, parakeetTranscribe } from './parakeet'
import * as AsrEnsure from './asr-bundled-ensure'
import {
  PARAKEET_REQUIRED_FILES,
  parakeetFilesReady,
  setAsrEnsureTestHooks,
  type AsrEnsureTestHooks
} from './asr-bundled-ensure'

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
    nativeHost.fork.mockClear()
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
    setAsrEnsureTestHooks(
      withTestResources({
        fetchParakeet: async (dest, onProgress) => {
          writeParakeet(dest)
          onProgress?.(40)
          onProgress?.(100)
        }
      })
    )

    await expect(parakeetModelReady()).resolves.toBe(false)
    await expect(ensureParakeetModel(progressSpy)).resolves.toBeUndefined()
    await expect(parakeetModelReady()).resolves.toBe(true)
    expect(progressSpy).toHaveBeenCalled()
    await expect(ensureParakeetModel(progressSpy)).resolves.toBeUndefined()
  })

  it('rejects Access login HTML at the content validation gate before model use', async () => {
    const dir = join(paths.userData, 'asr-models', 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8')
    mkdirSync(dir, { recursive: true })
    const html = '<!DOCTYPE html><html><body>cloudflareaccess.com Sign in</body></html>'
    for (const name of PARAKEET_REQUIRED_FILES) writeFileSync(join(dir, name), html)
    await expect(parakeetFilesReady(dir)).resolves.toBe(false)
  })

  it('keeps the Parakeet status probe from opening model files', async () => {
    writeParakeet(join(paths.resources, 'asr', 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'))
    modelOpenGuard.calls = 0
    modelOpenGuard.active = true
    try {
      await expect(parakeetModelReady()).resolves.toBe(true)
      expect(modelOpenGuard.calls).toBe(0)
    } finally {
      modelOpenGuard.active = false
    }
  })

  it('does not start a helper when release wins during async model-path resolution', async () => {
    let releasePath!: (path: string) => void
    let reportPathStart!: () => void
    const pathPending = new Promise<string>((resolve) => {
      releasePath = resolve
    })
    const pathStarted = new Promise<void>((resolve) => {
      reportPathStart = resolve
    })
    const resolvePath = vi.spyOn(AsrEnsure, 'resolveParakeetDir').mockImplementation(() => {
      reportPathStart()
      return pathPending
    })
    try {
      const pending = parakeetTranscribe(new Float32Array(16))
      await pathStarted
      await parakeetRelease()
      releasePath('/tmp/obsolete-model-path')
      await expect(pending).rejects.toThrow('cancelled')
      expect(nativeHost.fork).not.toHaveBeenCalled()
    } finally {
      resolvePath.mockRestore()
    }
  })

  it('does not start a legacy transfer when release wins during async warmup readiness', async () => {
    let releaseReadiness!: (ready: boolean) => void
    let reportReadinessStart!: () => void
    const readinessPending = new Promise<boolean>((resolve) => {
      releaseReadiness = resolve
    })
    const readinessStarted = new Promise<void>((resolve) => {
      reportReadinessStart = resolve
    })
    const ready = vi.spyOn(AsrEnsure, 'parakeetFilesReady').mockImplementation(() => {
      reportReadinessStart()
      return readinessPending
    })
    const ensure = vi.spyOn(AsrEnsure, 'ensureParakeetAssets')
    try {
      const pending = ensureParakeetModel()
      await readinessStarted
      await parakeetRelease()
      releaseReadiness(false)
      await expect(pending).rejects.toThrow('cancelled')
      expect(ensure).not.toHaveBeenCalled()
    } finally {
      ready.mockRestore()
      ensure.mockRestore()
    }
  })

  it('a development fetch failure stays an honest connection error', async () => {
    setAsrEnsureTestHooks(
      withTestResources({
        fetchParakeet: async () => {
          throw new Error('network down')
        }
      })
    )
    await expect(ensureParakeetModel()).rejects.toThrow(/network down/)
  })

  it('keeps the production module free of downloader and extractor dependencies', () => {
    const source = readFileSync(join(__dirname, 'parakeet.ts'), 'utf8')
    expect(source).not.toMatch(/node:https|node:http|createWriteStream|execFile|MODEL_URL/)
    expect(source).toMatch(/ensureParakeetAssets/)
  })
})
