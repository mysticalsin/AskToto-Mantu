import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'

vi.mock('electron')
vi.mock('../logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../logger')>()),
  auditLog: vi.fn()
}))

const ramState = vi.hoisted(() => ({ totalMemBytes: 64 * 1024 ** 3 }))
const diskState = vi.hoisted(() => ({ freeBytes: 512 * 1024 ** 3 }))
// M2-0035: counts real SHA-256 hashing work so the cache tests can assert a re-hash was SKIPPED or
// FORCED without reaching into local-models.ts internals — this wraps the same real `createHash`
// (via importOriginal) rather than replacing it, so every hash in these tests is still genuine.
const hashState = vi.hoisted(() => ({ calls: 0 }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, totalmem: () => ramState.totalMemBytes }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    statfsSync: () => ({ bsize: 4096, bavail: Math.floor(diskState.freeBytes / 4096) })
  }
})
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return {
    ...actual,
    createHash: ((...args: Parameters<typeof actual.createHash>) => {
      hashState.calls++
      return actual.createHash(...args)
    }) as typeof actual.createHash
  }
})

import {
  LOCAL_MODELS,
  advertisedRamGB,
  assertRamOk,
  bestModelForMachine,
  diskShortageFor,
  isDownloaded,
  listModels,
  modelPaths,
  verifyIntegrity,
  ChecksumMismatchError,
  InsufficientRamError,
  InvalidBundledModelError,
  type LocalModelEntry,
  type LocalModelFile
} from './local-models'
import { auditLog } from '../logger'
import { armQaHostFloorOverride, productionHkMDeps, type HkMModules, type HkMRamFloorOverride } from '../qa-hk-m'

const mockAppGetPath = app.getPath as ReturnType<typeof vi.fn>

/** The only way to obtain a counted token: the one the HK-M hook's model start passes along. */
async function hkMRamFloorOverride(): Promise<HkMRamFloorOverride> {
  let override: HkMRamFloorOverride | undefined
  const modules = {
    ensureLocalRuntimeStarted: async (_id: string, _vision?: boolean, _gate?: () => boolean, token?: HkMRamFloorOverride) => {
      override = token
    }
  } as unknown as HkMModules
  await productionHkMDeps(modules, vi.fn(), vi.fn(), '/qa-profile', '/resources').startLocalModel()
  if (!override) throw new Error('the HK-M model start passed no override')
  return override
}

/** What index.ts does once at boot, against this test's default userData path. */
function armGateFromProcess(): boolean {
  return armQaHostFloorOverride(process.env, app.isPackaged, app.getPath('userData'))
}
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
    diskState.freeBytes = 512 * 1024 ** 3
    hashState.calls = 0
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

    it('reads the included compact model from packaged resources, without changing optional model paths', () => {
      const resourcesPath = join(userData, 'packaged-resources')
      Object.defineProperty(app, 'isPackaged', { configurable: true, value: true })
      Object.defineProperty(process, 'resourcesPath', { configurable: true, value: resourcesPath })

      // Runtime reads the installed compact payload. Its downloader must never write into the bundle.
      expect(modelPaths('qwen3.5-0.8b')).toEqual({
        dir: join(resourcesPath, 'local-llm', 'models', 'qwen3.5-0.8b'),
        gguf: join(resourcesPath, 'local-llm', 'models', 'qwen3.5-0.8b', 'model.gguf'),
        mmproj: join(resourcesPath, 'local-llm', 'models', 'qwen3.5-0.8b', 'mmproj.gguf'),
        ctxSize: expect.any(Number),
        parallel: expect.any(Number),
        gpuLayers: expect.any(Number)
      })
      expect(modelPaths('qwen3.5-4b').dir).toBe(join(userData, 'local-llm', 'models', 'qwen3.5-4b'))
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

    it('treats an advertised 8 GB machine (7.45 GiB raw) as eligible, not under-floor', () => {
      // 8 × 10^9 / 1024^3 — what totalmem() returns on many 8 GB Macs/PCs. Raw compare against
      // minTotalRamGB: 8 used to skip the first-run fetch entirely.
      ramState.totalMemBytes = 8e9
      expect(advertisedRamGB()).toBe(8)
      expect(() => assertRamOk('qwen3.5-0.8b')).not.toThrow()
      expect(() => assertRamOk('qwen3.5-4b')).not.toThrow()
      expect(bestModelForMachine().id).toBe('qwen3.5-4b')
      expect(listModels()[0].unavailableReason).not.toBe('insufficient-ram')
    })

    // M2-0460: hosted macOS runners expose exactly 7 GiB. The user-facing gate stays as it is: 7 GiB refuses, the
    // 8 GB class allows.
    it('refuses a 7 GiB machine and allows an 8 GiB machine', () => {
      setTotalMemGB(7)
      expect(() => assertRamOk('qwen3.5-0.8b')).toThrow(InsufficientRamError)
      setTotalMemGB(8)
      expect(() => assertRamOk('qwen3.5-0.8b')).not.toThrow()
    })

    // M2-0460's HK-M lift, now a caller of the one qaHostFloorOverride gate (M2-0482).
    describe('HK-M override', () => {
      beforeEach(() => {
        setTotalMemGB(7)
        vi.mocked(auditLog).mockClear()
        vi.stubEnv('ASKTOTO_USERDATA', '/qa-profile')
        vi.stubEnv('METIS_HK_M_SCENARIO', 'model-starting')
        Object.defineProperty(app, 'isPackaged', { configurable: true, value: true })
        Object.defineProperty(process, 'resourcesPath', { configurable: true, value: join(userData, 'packaged-resources') })
      })

      afterEach(() => {
        vi.unstubAllEnvs()
        armQaHostFloorOverride({}, false, userData)
      })

      it('lets the HK-M model start past the floor on a 7 GiB packaged QA host, and records it', async () => {
        const override = await hkMRamFloorOverride()
        expect(() => assertRamOk('qwen3.5-0.8b')).toThrow(InsufficientRamError)
        // The token alone lifts nothing: only the armed gate does.
        expect(() => assertRamOk('qwen3.5-0.8b', override)).toThrow(InsufficientRamError)
        armGateFromProcess()
        expect(() => assertRamOk('qwen3.5-0.8b', override)).not.toThrow()
        expect(auditLog).toHaveBeenCalledWith('hk-m.ram-floor-override', {
          modelId: 'qwen3.5-0.8b',
          advertisedGB: 7,
          requiredGB: 8,
          totalmemBytes: 7 * 1024 ** 3
        })
        expect(auditLog).toHaveBeenCalledWith('local.host-floor-override', {
          floor: 'advertised-ram',
          hostTotalBytes: 7 * 1024 ** 3,
          hostAvailableBytes: expect.any(Number)
        })
        // The cold-start verification carries it too: with no bundle on disk the start now fails on the files,
        // not on the RAM floor.
        armQaHostFloorOverride({}, false, userData)
        await expect(verifyIntegrity('qwen3.5-0.8b')).rejects.toBeInstanceOf(InsufficientRamError)
        await expect(verifyIntegrity('qwen3.5-0.8b', override)).rejects.toBeInstanceOf(InsufficientRamError)
        armGateFromProcess()
        await expect(verifyIntegrity('qwen3.5-0.8b', override)).rejects.toBeInstanceOf(InvalidBundledModelError)
      })

      it('lifts any start of an armed HK-M process, but marks only the hook\'s own start', () => {
        armGateFromProcess()
        expect(() => assertRamOk('qwen3.5-0.8b')).not.toThrow()
        expect(() => assertRamOk('qwen3.5-0.8b', { kind: 'hk-m-ram-floor' })).not.toThrow()
        expect(auditLog).not.toHaveBeenCalledWith('hk-m.ram-floor-override', expect.anything())
      })

      it('refuses a look-alike token, and the real one outside the HK-M gate', async () => {
        const override = await hkMRamFloorOverride()
        expect(() => assertRamOk('qwen3.5-0.8b', { kind: 'hk-m-ram-floor' })).toThrow(InsufficientRamError)
        Object.defineProperty(app, 'isPackaged', { configurable: true, value: false })
        armGateFromProcess()
        expect(() => assertRamOk('qwen3.5-0.8b', override)).toThrow(InsufficientRamError)
        Object.defineProperty(app, 'isPackaged', { configurable: true, value: true })
        vi.stubEnv('METIS_HK_M_SCENARIO', '')
        armGateFromProcess()
        expect(() => assertRamOk('qwen3.5-0.8b', override)).toThrow(InsufficientRamError)
        vi.stubEnv('METIS_HK_M_SCENARIO', 'model-starting')
        vi.stubEnv('ASKTOTO_USERDATA', '')
        armGateFromProcess()
        expect(() => assertRamOk('qwen3.5-0.8b', override)).toThrow(InsufficientRamError)
        vi.stubEnv('ASKTOTO_USERDATA', userData)
        armGateFromProcess()
        expect(() => assertRamOk('qwen3.5-0.8b', override)).toThrow(InsufficientRamError)
        expect(auditLog).not.toHaveBeenCalledWith('hk-m.ram-floor-override', expect.anything())
        expect(auditLog).not.toHaveBeenCalledWith('local.host-floor-override', expect.anything())
      })

      it('changes nothing on a machine that already meets the floor', async () => {
        setTotalMemGB(8)
        const override = await hkMRamFloorOverride()
        armGateFromProcess()
        expect(() => assertRamOk('qwen3.5-0.8b', override)).not.toThrow()
        expect(auditLog).not.toHaveBeenCalledWith('hk-m.ram-floor-override', expect.anything())
        expect(auditLog).not.toHaveBeenCalledWith('local.host-floor-override', expect.anything())
      })
    })

    describe('QA host-floor override (M2-0482)', () => {
      beforeEach(() => {
        setTotalMemGB(7)
        vi.mocked(auditLog).mockClear()
        vi.stubEnv('ASKTOTO_USERDATA', '/qa-profile')
        vi.stubEnv('METIS_QA_HOST_FLOOR_OVERRIDE', '1')
        Object.defineProperty(app, 'isPackaged', { configurable: true, value: true })
        Object.defineProperty(process, 'resourcesPath', { configurable: true, value: join(userData, 'packaged-resources') })
      })

      afterEach(() => {
        vi.unstubAllEnvs()
        armQaHostFloorOverride({}, false, userData)
      })

      it('the explicit env alone never lifts the floor: only the armed gate does', () => {
        expect(() => assertRamOk('qwen3.5-0.8b')).toThrow(InsufficientRamError)
        armGateFromProcess()
        expect(() => assertRamOk('qwen3.5-0.8b')).not.toThrow()
      })

      it('emits one content-free local.host-floor-override per process, and no HK-M marker outside an HK-M row', () => {
        armGateFromProcess()
        assertRamOk('qwen3.5-0.8b')
        assertRamOk('qwen3.5-0.8b')
        const overrides = vi.mocked(auditLog).mock.calls.filter(([event]) => event === 'local.host-floor-override')
        expect(overrides).toEqual([
          ['local.host-floor-override', { floor: 'advertised-ram', hostTotalBytes: 7 * 1024 ** 3, hostAvailableBytes: expect.any(Number) }]
        ])
        expect(Object.keys(overrides[0][1] as object).sort()).toEqual(['floor', 'hostAvailableBytes', 'hostTotalBytes'])
        expect(auditLog).not.toHaveBeenCalledWith('hk-m.ram-floor-override', expect.anything())
      })

      it('leaves model choice and the user-facing readiness on the real host', () => {
        const unarmed = { best: bestModelForMachine().id, reason: listModels()[0].unavailableReason }
        armGateFromProcess()
        expect(bestModelForMachine().id).toBe(unarmed.best)
        expect(listModels()[0].unavailableReason).toBe(unarmed.reason)
        expect(listModels()[0].unavailableReason).toBe('insufficient-ram')
      })
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
          source: 'download',
          // MQA-187/191: "missing files" was rendered as a damaged install. With no download state to
          // fold in, a never-attempted fetch is exactly that and nothing stronger.
          unavailableReason: 'not-downloaded',
          downloadProgress: 0,
          downloadError: null
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
          source: 'download',
          unavailableReason: null,
          downloadProgress: 0,
          downloadError: null
        }
      ])
    })

    it('a full volume is insufficient-disk, not a silent not-downloaded idle', () => {
      diskState.freeBytes = 1024
      expect(diskShortageFor(LOCAL_MODELS[0].id)).toMatch(/not enough free disk/i)
      expect(listModels()[0]).toMatchObject({
        ready: false,
        unavailableReason: 'insufficient-disk',
        downloadError: expect.stringMatching(/not enough free disk/i)
      })
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

  describe('M2-0035: cached integrity verification', () => {
    // A small, genuinely pinned-and-matching payload (not the real multi-GB GGUF) — same technique
    // local-model-bundle.test.ts uses to exercise the real hash pipeline without shipping a fixture the
    // size of the production model.
    const GOOD = Buffer.from('a small synthetic payload standing in for the pinned GGUF bytes')
    const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
    // Computed once, at collection time — before the outer beforeEach zeroes hashState.calls — so setting
    // up GOOD's pinned digest never itself counts as a verification hash inside a test.
    const GOOD_SHA256 = sha256(GOOD)
    let model: LocalModelEntry
    let originalGguf: LocalModelFile
    let originalMmproj: LocalModelFile

    beforeEach(() => {
      model = LOCAL_MODELS[0]
      originalGguf = model.gguf
      originalMmproj = model.mmproj
      model.gguf = { ...model.gguf, bytes: GOOD.length, sha256: GOOD_SHA256 }
      model.mmproj = { ...model.mmproj, bytes: GOOD.length, sha256: GOOD_SHA256 }
      const paths = modelPaths(model.id)
      mkdirSync(paths.dir, { recursive: true })
      writeFileSync(paths.gguf, GOOD)
      writeFileSync(paths.mmproj, GOOD)
    })

    afterEach(() => {
      model.gguf = originalGguf
      model.mmproj = originalMmproj
    })

    it('skips re-hashing on a second cold start when the file identity (size, mtime, ctime, inode) is unchanged', async () => {
      await expect(verifyIntegrity(model.id)).resolves.toBeUndefined()
      // One real hash per model file (gguf + mmproj) — GOOD_SHA256 above did no counted hashing inside
      // this test, so this is exactly the first verification's own work, not an artifact of setup.
      expect(hashState.calls).toBe(2)

      await expect(verifyIntegrity(model.id)).resolves.toBeUndefined()
      // No new hashing on the second, unchanged cold start — this is the whole point of the cache.
      expect(hashState.calls).toBe(2)
    })

    it('re-verifies (and fails closed) the moment a previously-verified file changes on disk', async () => {
      await expect(verifyIntegrity(model.id)).resolves.toBeUndefined()
      const afterFirstColdStart = hashState.calls

      // Tamper with the gguf after it was already cached as verified. Different length than GOOD, so
      // the identity check cannot pass by coincidence regardless of filesystem mtime resolution.
      const paths = modelPaths(model.id)
      writeFileSync(paths.gguf, Buffer.from('tampered after a prior successful verification'))

      await expect(verifyIntegrity(model.id)).rejects.toBeInstanceOf(ChecksumMismatchError)
      // The changed file was re-hashed, not waved through on the strength of the stale cache entry.
      expect(hashState.calls).toBeGreaterThan(afterFirstColdStart)
    })

    it('does not cache a failed verification, so a repaired file verifies', async () => {
      const paths = modelPaths(model.id)
      writeFileSync(paths.gguf, Buffer.from('corrupt on the very first cold start'))
      await expect(verifyIntegrity(model.id)).rejects.toBeInstanceOf(ChecksumMismatchError)

      // Explicit repair: the file is rewritten with the correct pinned bytes (what a re-download does).
      writeFileSync(paths.gguf, GOOD)
      await expect(verifyIntegrity(model.id)).resolves.toBeUndefined()
    })

    it('rejects a same-size in-place tamper with its mtime put back, because ctime cannot be rolled back', async () => {
      const paths = modelPaths(model.id)
      // A whole-second instant so it can be restored to the exact value below on every filesystem's mtime
      // resolution, not just ones that keep sub-second precision.
      const verifiedMtime = new Date(Math.floor(Date.now() / 1000) * 1000)
      utimesSync(paths.gguf, verifiedMtime, verifiedMtime)
      const verifiedStat = statSync(paths.gguf)

      await expect(verifyIntegrity(model.id)).resolves.toBeUndefined()

      // Longer than filesystem timestamp granularity, so the tamper below provably moves ctime forward
      // rather than landing in the same tick as the verified stat by coincidence.
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Same length as GOOD, different bytes, mtime put back — everything but ctime matches the verified
      // stat, and only ctime cannot be forged with utimes.
      writeFileSync(paths.gguf, Buffer.alloc(GOOD.length, 0x58))
      utimesSync(paths.gguf, verifiedMtime, verifiedMtime)

      const tamperedStat = statSync(paths.gguf)
      expect(tamperedStat.size).toBe(verifiedStat.size)
      expect(tamperedStat.mtimeMs).toBe(verifiedStat.mtimeMs)
      expect(tamperedStat.ino).toBe(verifiedStat.ino)

      await expect(verifyIntegrity(model.id)).rejects.toBeInstanceOf(ChecksumMismatchError)
    })

    it('rejects a same-size, same-mtime replacement renamed over the verified file', async () => {
      const paths = modelPaths(model.id)
      const fixedMtime = new Date(Math.floor(Date.now() / 1000) * 1000)
      utimesSync(paths.gguf, fixedMtime, fixedMtime)

      await expect(verifyIntegrity(model.id)).resolves.toBeUndefined()

      // Same length as GOOD, different bytes, same mtime as the original — built at a separate path so
      // the rename below gives the gguf path a new inode instead of rewriting the original's.
      const replacementPath = join(paths.dir, 'replacement.gguf')
      writeFileSync(replacementPath, Buffer.alloc(GOOD.length, 0x59))
      utimesSync(replacementPath, fixedMtime, fixedMtime)
      renameSync(replacementPath, paths.gguf)

      await expect(verifyIntegrity(model.id)).rejects.toBeInstanceOf(ChecksumMismatchError)
    })
  })
})
