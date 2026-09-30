import { describe, expect, it, vi } from 'vitest'
import {
  HK_M_SCENARIOS,
  hkMRamFloorOverrideActive,
  hkMScenarioFromEnv,
  hkMSetupFailedDetail,
  productionHkMDeps,
  runHkMScenario,
  type HkMDeps,
  type HkMModules
} from './qa-hk-m'

function fakeDeps(overrides: Partial<HkMDeps> = {}): HkMDeps & { order: string[] } {
  const order: string[] = []
  return {
    order,
    audit: vi.fn((event) => void order.push(`audit:${event}`)),
    startLocalModel: vi.fn(async () => void order.push('model-healthy')),
    beginInference: vi.fn(() => void order.push('inference-dispatched')),
    holdFfmpegDecode: vi.fn(async () => void order.push('ffmpeg-producing')),
    writeRegistryUntilKilled: vi.fn(() => void order.push('registry-loop')),
    onError: vi.fn(),
    ...overrides
  }
}

describe('hkMScenarioFromEnv', () => {
  it('is inert unless packaged, on an isolated profile, and naming a known row', () => {
    const env = { ASKTOTO_USERDATA: '/qa-profile', METIS_HK_M_SCENARIO: 'active-inference' }
    expect(hkMScenarioFromEnv(env, true)).toBe('active-inference')
    expect(hkMScenarioFromEnv(env, false)).toBeNull()
    expect(hkMScenarioFromEnv({ METIS_HK_M_SCENARIO: 'active-inference' }, true)).toBeNull()
    expect(hkMScenarioFromEnv({ ...env, METIS_HK_M_SCENARIO: 'other' }, true)).toBeNull()
    expect(hkMScenarioFromEnv({ ASKTOTO_USERDATA: '/qa-profile' }, true)).toBeNull()
  })

  it('accepts every row the harness drives', () => {
    for (const scenario of HK_M_SCENARIOS) {
      expect(hkMScenarioFromEnv({ ASKTOTO_USERDATA: '/qa-profile', METIS_HK_M_SCENARIO: scenario }, true)).toBe(scenario)
    }
  })
})

describe('runHkMScenario', () => {
  it('idle does nothing', async () => {
    const deps = fakeDeps()
    await runHkMScenario('idle', deps)
    expect(deps.order).toEqual([])
  })

  it('model-starting starts the model without waiting for it to be healthy', async () => {
    let release!: () => void
    const deps = fakeDeps({ startLocalModel: vi.fn(() => new Promise<void>((resolve) => (release = resolve))) })
    await runHkMScenario('model-starting', deps)
    expect(deps.startLocalModel).toHaveBeenCalledTimes(1)
    expect(deps.audit).not.toHaveBeenCalled()
    release()
  })

  it('active-inference marks only after the model is healthy and a completion is in flight', async () => {
    const deps = fakeDeps()
    await runHkMScenario('active-inference', deps)
    expect(deps.order).toEqual(['model-healthy', 'inference-dispatched', 'audit:hk-m.active-inference'])
  })

  it('ffmpeg-import marks only once the decoder is producing', async () => {
    const deps = fakeDeps()
    await runHkMScenario('ffmpeg-import', deps)
    expect(deps.order).toEqual(['ffmpeg-producing', 'audit:hk-m.ffmpeg-import'])
  })

  it('registry-write marks, then keeps writing', async () => {
    const deps = fakeDeps()
    await runHkMScenario('registry-write', deps)
    expect(deps.order).toEqual(['audit:hk-m.registry-write', 'registry-loop'])
  })

  it('reports a failed row instead of stamping its marker', async () => {
    const failure = new Error('bundled ffmpeg missing')
    const deps = fakeDeps({ holdFfmpegDecode: vi.fn(async () => Promise.reject(failure)) })
    await runHkMScenario('ffmpeg-import', deps)
    expect(deps.audit).not.toHaveBeenCalled()
    expect(deps.onError).toHaveBeenCalledWith('ffmpeg-import', failure)
  })
})

describe('hkMSetupFailedDetail', () => {
  it('carries the row and the Error class name, never the message', () => {
    class InsufficientRamError extends Error {
      constructor() {
        super('This model needs at least 8 GB of RAM; this machine has 7.0 GB.')
        this.name = 'InsufficientRamError'
      }
    }
    const detail = hkMSetupFailedDetail('model-starting', new InsufficientRamError())
    expect(detail).toEqual({ row: 'model-starting', error: 'InsufficientRamError' })
    expect(JSON.stringify(detail)).not.toMatch(/GB|RAM/)
  })

  it('never lets a crafted name or a non-Error value carry content', () => {
    const crafted = Object.assign(new Error('x'), { name: '/Users/someone/model.gguf failed' })
    expect(hkMSetupFailedDetail('active-inference', crafted)).toEqual({ row: 'active-inference', error: 'Error' })
    expect(hkMSetupFailedDetail('active-inference', 'transcript text')).toEqual({ row: 'active-inference', error: 'NonError' })
  })
})

const HK_M_ENV = { ASKTOTO_USERDATA: '/qa-profile', METIS_HK_M_SCENARIO: 'model-starting' }

async function modelStartArgs(): Promise<unknown[]> {
  const ensureLocalRuntimeStarted = vi.fn(async () => {})
  const modules = {
    ensureLocalRuntimeStarted,
    localRuntime: { markActivity: vi.fn(), baseURL: vi.fn(), sessionKey: vi.fn() },
    bundledFfmpegPath: vi.fn(),
    startFfmpegDecode: vi.fn(),
    recordSidecarIntent: vi.fn()
  } as unknown as HkMModules
  await productionHkMDeps(modules, vi.fn(), vi.fn(), '/qa-profile', '/resources').startLocalModel()
  expect(ensureLocalRuntimeStarted).toHaveBeenCalledTimes(1)
  return ensureLocalRuntimeStarted.mock.calls[0] as unknown[]
}

describe('HK-M RAM-floor override', () => {
  it('starts the bundled model through ensureLocalRuntimeStarted with a minted override, text-only and ungated', async () => {
    const [modelId, vision, canStartSpeculatively, override] = await modelStartArgs()
    expect(modelId).toBe('qwen3.5-0.8b')
    expect(vision).toBe(false)
    expect(canStartSpeculatively).toBeUndefined()
    expect(hkMRamFloorOverrideActive(override, HK_M_ENV, true)).toBe(true)
  })

  it('is inert unless packaged, on an isolated profile, and naming a known row', async () => {
    const [, , , override] = await modelStartArgs()
    expect(hkMRamFloorOverrideActive(override, HK_M_ENV, false)).toBe(false)
    expect(hkMRamFloorOverrideActive(override, { METIS_HK_M_SCENARIO: 'model-starting' }, true)).toBe(false)
    expect(hkMRamFloorOverrideActive(override, { ...HK_M_ENV, METIS_HK_M_SCENARIO: 'other' }, true)).toBe(false)
    expect(hkMRamFloorOverrideActive(override, {}, true)).toBe(false)
  })

  it('cannot be passed by any other caller: a look-alike or missing token is ignored even inside the HK-M gate', async () => {
    const [, , , minted] = await modelStartArgs()
    expect(hkMRamFloorOverrideActive({ ...(minted as object) }, HK_M_ENV, true)).toBe(false)
    expect(hkMRamFloorOverrideActive({ kind: 'hk-m-ram-floor' }, HK_M_ENV, true)).toBe(false)
    expect(hkMRamFloorOverrideActive(undefined, HK_M_ENV, true)).toBe(false)
    expect(hkMRamFloorOverrideActive(null, HK_M_ENV, true)).toBe(false)
  })
})
