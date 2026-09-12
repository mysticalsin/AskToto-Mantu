import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, net } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, SettingsSchema } from '@shared/ipc'
import { provisionLocalModel } from '../local-model-provisioning'
import { ensureLocalModel, localModelDownloadState } from './local-model-download'
import { getModel, isDownloaded, listModels, modelPaths, verifyIntegrity } from './local-models'
import { ensureLocalRuntimeStarted } from './local'
import * as localRuntime from './local-runtime'

vi.mock('electron')
vi.mock('../logger', () => ({ auditLog: vi.fn() }))
vi.mock('./local-runtime', () => ({ getState: () => 'stopped', getActiveModelKey: () => null, start: vi.fn(async () => {}) }))
vi.mock('./fm-runtime', () => ({}))
vi.mock('./openai', () => ({ streamOpenAI: vi.fn() }))
const machine = vi.hoisted(() => ({ ram: 16 * 1024 ** 3, freeDisk: 100 * 1024 ** 3 }))
vi.mock('node:os', async (original) => ({
  ...await original<typeof import('node:os')>(), totalmem: () => machine.ram
}))
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return {
    ...fs,
    statfsSync: () => ({ bavail: machine.freeDisk, bsize: 1 }),
    mkdirSync: vi.fn(fs.mkdirSync), rmSync: vi.fn(fs.rmSync),
    renameSync: vi.fn(fs.renameSync), createWriteStream: vi.fn(fs.createWriteStream), writeFileSync: vi.fn(fs.writeFileSync)
  }
})

const COMPACT = 'qwen3.5-0.8b'
const LARGE = 'qwen3.5-4b'
const WEIGHTS = Buffer.from('synthetic pinned GGUF')
const PROJECTOR = Buffer.from('synthetic pinned projector')
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const originals = [COMPACT, LARGE].map((id) => ({ entry: getModel(id), gguf: getModel(id).gguf, mmproj: getModel(id).mmproj }))
const fsWrites = [mkdirSync, rmSync, renameSync, createWriteStream, writeFileSync]
let root: string
let userData: string
let resources: string
let originalResources: PropertyDescriptor | undefined

function paths(base: string, id = COMPACT) {
  const dir = join(base, 'local-llm', 'models', id)
  return { dir, gguf: join(dir, 'model.gguf'), mmproj: join(dir, 'mmproj.gguf') }
}
function writeModel(base: string, id = COMPACT): void {
  const dest = paths(base, id)
  mkdirSync(dest.dir, { recursive: true })
  writeFileSync(dest.gguf, WEIGHTS)
  writeFileSync(dest.mmproj, PROJECTOR)
}
function expectNoModelWrites(): void {
  for (const fn of fsWrites) expect(fn).not.toHaveBeenCalled()
  expect(net.fetch).not.toHaveBeenCalled()
}
function clearWriteSpies(): void {
  for (const fn of fsWrites) vi.mocked(fn).mockClear()
}
function stubDownload(): void {
  vi.mocked(net.fetch).mockImplementation(async (url) => {
    const data = String(url).endsWith('/model.gguf') ? WEIGHTS : PROJECTOR
    return new Response(new Uint8Array(data), { headers: { 'content-length': String(data.length) } })
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'metis-bundled-llm-'))
  userData = join(root, 'profile')
  resources = join(root, 'resources')
  mkdirSync(userData)
  Object.defineProperty(app, 'isPackaged', { configurable: true, value: true })
  originalResources = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: resources })
  vi.mocked(app.getPath).mockImplementation((name) => name === 'userData' ? userData : join(root, name))
  machine.ram = 16 * 1024 ** 3
  machine.freeDisk = 100 * 1024 ** 3
  // Tiny real files exercise the production size/hash pipeline, not mocked verification results.
  // Restore the reviewed manifest objects after each test; no weight downloads are performed.
  for (const { entry } of originals) {
    entry.gguf = { bytes: WEIGHTS.length, sha256: sha(WEIGHTS), url: `https://example.invalid/${entry.id}/model.gguf` }
    entry.mmproj = { bytes: PROJECTOR.length, sha256: sha(PROJECTOR), url: `https://example.invalid/${entry.id}/mmproj.gguf` }
  }
  vi.mocked(net.fetch).mockReset().mockRejectedValue(new Error('synthetic offline device'))
  vi.mocked(localRuntime.start).mockClear()
  clearWriteSpies()
})
afterEach(() => {
  for (const { entry, gguf, mmproj } of originals) { entry.gguf = gguf; entry.mmproj = mmproj }
  if (originalResources) Object.defineProperty(process, 'resourcesPath', originalResources)
  else delete (process as { resourcesPath?: string }).resourcesPath
  Object.defineProperty(app, 'isPackaged', { configurable: true, value: false })
  rmSync(root, { recursive: true, force: true })
})

describe('MQA-319: installed compact local model is verified and read-only', () => {
  it('resolves compact resources first, even when a downloaded copy is present', () => {
    writeModel(resources)
    writeModel(userData)
    expect(modelPaths(COMPACT)).toMatchObject(paths(resources))
    expect(listModels()[0]).toMatchObject({ source: 'bundled', ready: true, unavailableReason: null })
  })

  it('enables a valid bundled model offline without downloads, writes, or requiring duplicate disk space', async () => {
    writeModel(resources)
    clearWriteSpies()
    machine.freeDisk = 0
    const local = { ...DEFAULT_SETTINGS.localLlm, enabled: true }
    await expect(provisionLocalModel(local, ['local'], ensureLocalModel)).resolves.toBe(true)
    await expect(verifyIntegrity(COMPACT)).resolves.toBeUndefined()
    expect(localModelDownloadState().status).toBe('idle')
    expect(modelPaths(COMPACT)).toMatchObject(paths(resources))
    expect(isDownloaded(COMPACT)).toBe(true)
    expect(listModels()[0]).toMatchObject({ ready: true, source: 'bundled', downloadError: null })
    expect(existsSync(paths(userData).dir)).toBe(false)
    expectNoModelWrites()
  })

  it('does not opt a fresh profile into local inference or provisioning', async () => {
    writeModel(resources)
    clearWriteSpies()
    const local = SettingsSchema.parse(DEFAULT_SETTINGS).localLlm
    const ensure = vi.fn(ensureLocalModel)
    expect(local).toMatchObject({ enabled: false, modelId: COMPACT, useFor: { suggest: false, summary: false, vision: false } })
    await expect(provisionLocalModel(local, null, ensure)).resolves.toBe(false)
    expect(ensure).not.toHaveBeenCalled()
    expectNoModelWrites()
  })

  it('hands verified installed text and vision paths to the existing runtime without fetching', async () => {
    writeModel(resources)
    clearWriteSpies()
    await ensureLocalRuntimeStarted(COMPACT, true)
    expect(localRuntime.start).toHaveBeenCalledExactlyOnceWith({
      gguf: paths(resources).gguf, mmproj: paths(resources).mmproj, vision: true,
      ctxSize: expect.any(Number), parallel: expect.any(Number), gpuLayers: expect.any(Number)
    })
    expectNoModelWrites()
  })

  it('never starts the native runtime when bundled content fails verification', async () => {
    writeModel(resources)
    writeFileSync(paths(resources).gguf, Buffer.alloc(WEIGHTS.length))
    clearWriteSpies()
    await expect(ensureLocalRuntimeStarted(COMPACT)).rejects.toThrow(/repair|reinstall/i)
    expect(localRuntime.start).not.toHaveBeenCalled()
    expectNoModelWrites()
  })

  it.each(['directory', 'projector'] as const)('fails closed on a missing bundled %s, without using a downloaded copy', async (missing) => {
    writeModel(userData)
    if (missing === 'projector') {
      writeModel(resources)
      rmSync(paths(resources).mmproj)
    }
    clearWriteSpies()
    expect(modelPaths(COMPACT)).toMatchObject(paths(resources))
    expect(listModels()[0]).toMatchObject({ ready: false, source: 'bundled', unavailableReason: 'invalid-bundle' })
    await expect(ensureLocalModel(COMPACT)).resolves.toBe(false)
    await expect(verifyIntegrity(COMPACT)).rejects.toThrow(/repair|reinstall/i)
    expect(localModelDownloadState()).toMatchObject({ status: 'failed', error: expect.stringMatching(/repair|reinstall/i) })
    expect(localModelDownloadState().error).not.toMatch(/https?:|re-downloaded|connection/i)
    expectNoModelWrites()
  })

  it.each(['gguf', 'mmproj'] as const)('rejects same-size bundled %s corruption and never overwrites resources', async (file) => {
    writeModel(resources)
    writeModel(userData)
    const before = Buffer.alloc(file === 'gguf' ? WEIGHTS.length : PROJECTOR.length, 120)
    writeFileSync(paths(resources)[file], before)
    clearWriteSpies()
    await expect(ensureLocalModel(COMPACT)).resolves.toBe(false)
    await expect(verifyIntegrity(COMPACT)).rejects.toThrow(/repair|reinstall/i)
    expect(isDownloaded(COMPACT)).toBe(false)
    expect(listModels(localModelDownloadState())[0]).toMatchObject({
      source: 'bundled', ready: false, unavailableReason: 'invalid-bundle',
      downloadError: expect.stringMatching(/repair|reinstall/i)
    })
    expect(readFileSync(paths(resources)[file])).toEqual(before)
    expectNoModelWrites()
  })

  it('checks pinned size as well as hash before a cold start', async () => {
    writeModel(resources)
    getModel(COMPACT).gguf = { ...getModel(COMPACT).gguf, bytes: WEIGHTS.length + 1 }
    clearWriteSpies()
    await expect(verifyIntegrity(COMPACT)).rejects.toThrow(/repair|reinstall/i)
    expect(isDownloaded(COMPACT)).toBe(false)
    expectNoModelWrites()
  })

  it('keeps the RAM gate even when valid compact files are bundled', async () => {
    writeModel(resources)
    clearWriteSpies()
    machine.ram = 4 * 1024 ** 3
    await expect(ensureLocalModel(COMPACT)).resolves.toBe(false)
    await expect(verifyIntegrity(COMPACT)).rejects.toThrow(/at least 8 GB of RAM/)
    expect(listModels()[0]).toMatchObject({ ready: false, unavailableReason: 'insufficient-ram' })
    expectNoModelWrites()
  })

  it('allows a repaired bundle to be verified again without downloading', async () => {
    writeModel(resources)
    writeFileSync(paths(resources).gguf, Buffer.alloc(WEIGHTS.length))
    await expect(ensureLocalModel(COMPACT)).resolves.toBe(false)
    writeFileSync(paths(resources).gguf, WEIGHTS)
    vi.mocked(net.fetch).mockClear()
    clearWriteSpies()
    await expect(ensureLocalModel(COMPACT)).resolves.toBe(true)
    expect(listModels()[0]).toMatchObject({ ready: true, unavailableReason: null, downloadError: null })
    expectNoModelWrites()
  })

  it('keeps an explicitly selected 4B on the userData download path and leaves compact resources alone', async () => {
    writeModel(resources)
    clearWriteSpies()
    stubDownload()
    const local = SettingsSchema.parse({ ...DEFAULT_SETTINGS, localLlm: { ...DEFAULT_SETTINGS.localLlm, enabled: true, modelId: LARGE } }).localLlm
    await expect(provisionLocalModel(local, null, ensureLocalModel)).resolves.toBe(true)
    expect(local.modelId).toBe(LARGE)
    expect(modelPaths(LARGE)).toMatchObject(paths(userData, LARGE))
    expect(readFileSync(paths(userData, LARGE).gguf)).toEqual(WEIGHTS)
    expect(readFileSync(paths(resources).gguf)).toEqual(WEIGHTS)
    expect(listModels()[1]).toMatchObject({ ready: true, source: 'download' })
    expect(net.fetch).toHaveBeenCalledTimes(2)
    for (const fn of fsWrites) {
      for (const args of vi.mocked(fn).mock.calls) expect(String(args[0]).startsWith(resources)).toBe(false)
    }
  })

  it('retains unbundled development downloads in userData, even if resource fixtures exist', async () => {
    Object.defineProperty(app, 'isPackaged', { configurable: true, value: false })
    writeModel(resources)
    stubDownload()
    await expect(ensureLocalModel(COMPACT)).resolves.toBe(true)
    expect(modelPaths(COMPACT)).toMatchObject(paths(userData))
    expect(readFileSync(paths(userData).gguf)).toEqual(WEIGHTS)
    expect(listModels()[0]).toMatchObject({ ready: true, source: 'download' })
    expect(net.fetch).toHaveBeenCalledTimes(2)
  })
})
