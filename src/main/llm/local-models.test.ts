import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'

vi.mock('electron')

const ramState = vi.hoisted(() => ({ totalMemBytes: 64 * 1024 ** 3 }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, totalmem: () => ramState.totalMemBytes }
})

import {
  LOCAL_MODELS,
  assertRamOk,
  isDownloaded,
  listModels,
  modelPaths,
  verifyIntegrity,
  ChecksumMismatchError,
  InsufficientRamError
} from './local-models'

const mockAppGetPath = app.getPath as ReturnType<typeof vi.fn>
const source = readFileSync(join(__dirname, 'local-models.ts'), 'utf8')

function setTotalMemGB(gb: number): void {
  ramState.totalMemBytes = gb * 1024 ** 3
}

describe('bundled local model runtime', () => {
  let userData: string
  let originalResourcesPath: PropertyDescriptor | undefined

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'metis-local-models-test-'))
    mockAppGetPath.mockImplementation((name: string) => (name === 'userData' ? userData : join(userData, name)))
    Object.defineProperty(app, 'isPackaged', { configurable: true, value: false })
    originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
    setTotalMemGB(64)
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
    if (originalResourcesPath) Object.defineProperty(process, 'resourcesPath', originalResourcesPath)
    else delete (process as unknown as { resourcesPath?: string }).resourcesPath
    vi.restoreAllMocks()
  })

  describe('single pinned manifest', () => {
    it('pins EVERY registry entry to an IMMUTABLE upstream revision', () => {
      // The registry is multi-model (a small floor model plus the best one an 8 GB machine can hold), so
      // this asserts the supply-chain property for all of them rather than naming one. The weights are
      // fetched on first run instead of bundled, which makes each URL part of the supply chain: a branch
      // or tag ref would let upstream move the bytes underneath us, so require a 40-hex commit in the
      // path so the revision cannot change, and https so it cannot be downgraded.
      expect(LOCAL_MODELS.length).toBeGreaterThan(0)
      for (const model of LOCAL_MODELS) {
        expect(model.id).toMatch(/^qwen3\.5-/)
        expect(model.label).toBeTruthy()
        expect(model.ctxSize).toBeGreaterThan(0)
        expect(model.minTotalRamGB).toBeGreaterThan(0)
        for (const file of [model.gguf, model.mmproj]) {
          expect(file.url).toMatch(/^https:\/\//)
          expect(file.url).toMatch(/\/resolve\/[0-9a-f]{40}\//)
          expect(file.sha256).toMatch(/^[0-9a-f]{64}$/)
          expect(file.bytes).toBeGreaterThan(0)
        }
      }
      // Ids must be unique — getModel() resolves by id.
      expect(new Set(LOCAL_MODELS.map((m) => m.id)).size).toBe(LOCAL_MODELS.length)
    })

    it('keeps the verified byte sizes and sha256 pins for both files', () => {
      const model = LOCAL_MODELS[0]
      expect(model.gguf.bytes).toBe(558772480)
      expect(model.gguf.sha256).toBe('3177ebd67afe4438374da19e690bc1b98756f7e0fea9240e1be404336156a7b5')
      expect(model.mmproj.bytes).toBe(204987232)
      expect(model.mmproj.sha256).toBe('56e4c6cfe73b0c82e3e82bc518d7591997e61d81f723fc41a586f4fa69ea2453')
    })

    it('keeps the download OUT of this module — it owns pins and paths only', () => {
      // The fetch lives in local-model-download.ts so there is exactly one place installed code can
      // reach the network for weights. Deleting or bypassing that module's verification must not become
      // possible by quietly adding a second downloader here.
      expect(source).not.toMatch(/node:https|node:http/)
      expect(source).not.toMatch(/downloadModel|cancelDownload|deleteModel/)
    })
  })

  describe('runtime paths', () => {
    it('uses userData/local-llm/models in development and tests', () => {
      expect(modelPaths('qwen3.5-0.8b')).toEqual({
        dir: join(userData, 'local-llm', 'models', 'qwen3.5-0.8b'),
        gguf: join(userData, 'local-llm', 'models', 'qwen3.5-0.8b', 'model.gguf'),
        mmproj: join(userData, 'local-llm', 'models', 'qwen3.5-0.8b', 'mmproj.gguf'),
        // Carried with the paths so the spawn is fully described by one object (local-runtime ModelPaths).
        // Sizing is machine-aware (spawnProfileFor), so assert the shape rather than pinning this host's
        // RAM — the exact values are covered by local-spawn-profile.test.ts.
        ctxSize: expect.any(Number),
        parallel: expect.any(Number),
        gpuLayers: expect.any(Number)
      })
    })

    it('stays in userData when packaged — never inside the signed bundle', () => {
      const resourcesPath = join(userData, 'packaged-resources')
      Object.defineProperty(app, 'isPackaged', { configurable: true, value: true })
      Object.defineProperty(process, 'resourcesPath', { configurable: true, value: resourcesPath })

      // The weights are downloaded, so they must land somewhere writable. Writing into the .app would
      // fail on a read-only volume and break the bundle's code signature where it did not.
      expect(modelPaths('qwen3.5-0.8b')).toEqual({
        dir: join(userData, 'local-llm', 'models', 'qwen3.5-0.8b'),
        gguf: join(userData, 'local-llm', 'models', 'qwen3.5-0.8b', 'model.gguf'),
        mmproj: join(userData, 'local-llm', 'models', 'qwen3.5-0.8b', 'mmproj.gguf'),
        ctxSize: expect.any(Number),
        parallel: expect.any(Number),
        gpuLayers: expect.any(Number)
      })
      expect(modelPaths('qwen3.5-0.8b').dir).not.toContain(resourcesPath)
    })

    it('rejects the removed 2B model id', () => {
      expect(() => modelPaths('qwen3.5-2b')).toThrow(/Unknown local model id/)
    })
  })

  describe('RAM gate', () => {
    it('refuses a machine below the bundled model minimum', () => {
      setTotalMemGB(2)
      let thrown: unknown
      try {
        assertRamOk('qwen3.5-0.8b')
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(InsufficientRamError)
      const error = thrown as InsufficientRamError
      expect(error.modelId).toBe('qwen3.5-0.8b')
      expect(error.requiredGB).toBe(8)
      expect(error.availableGB).toBeCloseTo(2, 1)
      expect(error.suggestion).toBeUndefined()
    })

    it('allows a machine meeting the minimum', () => {
      setTotalMemGB(8)
      expect(() => assertRamOk('qwen3.5-0.8b')).not.toThrow()
    })
  })

  describe('bundled readiness metadata', () => {
    it('reports ready only when both bundled files have their pinned sizes', () => {
      const model = LOCAL_MODELS[0]
      const paths = modelPaths(model.id)

      expect(isDownloaded(model.id)).toBe(false)
      // The registry is multi-model now, so listModels() returns one summary per entry. Assert the one
      // under test by id instead of pinning the whole array, which would break on every model added.
      expect(listModels().filter((m) => m.id === model.id)).toEqual([
        {
          id: model.id,
          label: model.label,
          minTotalRamGB: model.minTotalRamGB,
          ready: false,
          // MQA-187/191: "missing files" was rendered as a damaged install. With no download state to
          // fold in, a never-attempted fetch is exactly that and nothing stronger.
          unavailableReason: 'not-downloaded',
          downloadProgress: 0
        }
      ])

      mkdirSync(paths.dir, { recursive: true })
      writeFileSync(paths.gguf, '')
      writeFileSync(paths.mmproj, '')
      truncateSync(paths.gguf, model.gguf.bytes)
      truncateSync(paths.mmproj, model.mmproj.bytes)

      expect(isDownloaded(model.id)).toBe(true)
      // Scoped to the entry under test — the registry holds more than one model now.
      expect(listModels().filter((m) => m.id === model.id)).toEqual([
        {
          id: model.id,
          label: model.label,
          minTotalRamGB: model.minTotalRamGB,
          ready: true,
          unavailableReason: null,
          downloadProgress: 0
        }
      ])
    })

    it('MQA-186 — under the RAM floor, the RAM cause outranks the missing weights', () => {
      // The weights are deliberately not fetched below minTotalRamGB (shouldFetchWeights), so a
      // "not downloaded yet" verdict would point at a download that is never going to be attempted and
      // hide the only thing the user can act on.
      setTotalMemGB(4)
      expect(listModels()[0]).toMatchObject({ ready: false, unavailableReason: 'insufficient-ram' })
    })

    it('MQA-187 — an in-flight fetch reads as downloading, with its progress, not as absent files', () => {
      expect(
        listModels({ modelId: LOCAL_MODELS[0].id, status: 'downloading', progress: 0.42 })[0]
      ).toMatchObject({ ready: false, unavailableReason: 'downloading', downloadProgress: 0.42 })
    })

    it('MQA-191 — download state for a DIFFERENT model id is ignored, never mislabelled', () => {
      expect(listModels({ modelId: 'some-other-model', status: 'downloading', progress: 0.9 })[0]).toMatchObject({
        unavailableReason: 'not-downloaded',
        downloadProgress: 0
      })
    })

    it('reports insufficient RAM honestly even when both bundled files are present', () => {
      const model = LOCAL_MODELS[0]
      const paths = modelPaths(model.id)
      mkdirSync(paths.dir, { recursive: true })
      writeFileSync(paths.gguf, '')
      writeFileSync(paths.mmproj, '')
      truncateSync(paths.gguf, model.gguf.bytes)
      truncateSync(paths.mmproj, model.mmproj.bytes)
      setTotalMemGB(4)

      expect(listModels()[0]).toMatchObject({ ready: false, unavailableReason: 'insufficient-ram' })
    })
  })

  describe('cold-start integrity verification', () => {
    it('enforces the RAM gate before llama-server can load the bundled files', async () => {
      setTotalMemGB(2)
      await expect(verifyIntegrity('qwen3.5-0.8b')).rejects.toBeInstanceOf(InsufficientRamError)
    })

    it('reports missing files as a pending first-run download, not a broken install', async () => {
      await expect(verifyIntegrity('qwen3.5-0.8b')).rejects.toThrow(/not downloaded yet/)
    })

    it('detects corruption against the pinned sha256 without deleting installed resources', async () => {
      const paths = modelPaths('qwen3.5-0.8b')
      mkdirSync(paths.dir, { recursive: true })
      writeFileSync(paths.gguf, Buffer.from('corrupt gguf content'))
      writeFileSync(paths.mmproj, Buffer.from('corrupt mmproj content'))

      let thrown: unknown
      try {
        await verifyIntegrity('qwen3.5-0.8b')
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(ChecksumMismatchError)
      const error = thrown as ChecksumMismatchError
      expect(error.modelId).toBe('qwen3.5-0.8b')
      expect(error.file).toBe('gguf')
      expect(error.expectedSha256).toBe(LOCAL_MODELS[0].gguf.sha256)
      expect(error.actualSha256).toBe(createHash('sha256').update('corrupt gguf content').digest('hex'))
      expect(existsSync(paths.gguf)).toBe(true)
    })
  })
})
