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
    else delete (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    vi.restoreAllMocks()
  })

  describe('single pinned manifest', () => {
    it('ships exactly Qwen3.5 0.8B and contains no runtime URL', () => {
      expect(LOCAL_MODELS.map((model) => model.id)).toEqual(['qwen3.5-0.8b'])
      expect(LOCAL_MODELS[0].label).toBe('Qwen3.5 0.8B')
      expect(LOCAL_MODELS[0].gguf).not.toHaveProperty('url')
      expect(LOCAL_MODELS[0].mmproj).not.toHaveProperty('url')
    })

    it('keeps the verified byte sizes and sha256 pins for both bundled files', () => {
      const model = LOCAL_MODELS[0]
      expect(model.gguf).toEqual({
        bytes: 558772480,
        sha256: '3177ebd67afe4438374da19e690bc1b98756f7e0fea9240e1be404336156a7b5'
      })
      expect(model.mmproj).toEqual({
        bytes: 204987232,
        sha256: '56e4c6cfe73b0c82e3e82bc518d7591997e61d81f723fc41a586f4fa69ea2453'
      })
    })

    it('contains no runtime download, cancellation, or deletion implementation', () => {
      expect(source).not.toMatch(/node:https|node:http/)
      expect(source).not.toMatch(/downloadModel|cancelDownload|deleteModel/)
      expect(source).not.toMatch(/huggingface\.co/)
    })
  })

  describe('runtime paths', () => {
    it('uses userData/local-llm/models in development and tests', () => {
      expect(modelPaths('qwen3.5-0.8b')).toEqual({
        dir: join(userData, 'local-llm', 'models', 'qwen3.5-0.8b'),
        gguf: join(userData, 'local-llm', 'models', 'qwen3.5-0.8b', 'model.gguf'),
        mmproj: join(userData, 'local-llm', 'models', 'qwen3.5-0.8b', 'mmproj.gguf')
      })
    })

    it('uses process.resourcesPath/local-llm/models in a packaged app', () => {
      const resourcesPath = join(userData, 'packaged-resources')
      Object.defineProperty(app, 'isPackaged', { configurable: true, value: true })
      Object.defineProperty(process, 'resourcesPath', { configurable: true, value: resourcesPath })

      expect(modelPaths('qwen3.5-0.8b')).toEqual({
        dir: join(resourcesPath, 'local-llm', 'models', 'qwen3.5-0.8b'),
        gguf: join(resourcesPath, 'local-llm', 'models', 'qwen3.5-0.8b', 'model.gguf'),
        mmproj: join(resourcesPath, 'local-llm', 'models', 'qwen3.5-0.8b', 'mmproj.gguf')
      })
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
      expect(listModels()).toEqual([
        {
          id: model.id,
          label: model.label,
          minTotalRamGB: model.minTotalRamGB,
          ready: false,
          unavailableReason: 'missing-files'
        }
      ])

      mkdirSync(paths.dir, { recursive: true })
      writeFileSync(paths.gguf, '')
      writeFileSync(paths.mmproj, '')
      truncateSync(paths.gguf, model.gguf.bytes)
      truncateSync(paths.mmproj, model.mmproj.bytes)

      expect(isDownloaded(model.id)).toBe(true)
      expect(listModels()).toEqual([
        {
          id: model.id,
          label: model.label,
          minTotalRamGB: model.minTotalRamGB,
          ready: true,
          unavailableReason: null
        }
      ])
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

    it('reports missing bundled files with reinstall guidance', async () => {
      await expect(verifyIntegrity('qwen3.5-0.8b')).rejects.toThrow(/Reinstall Métis/)
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
