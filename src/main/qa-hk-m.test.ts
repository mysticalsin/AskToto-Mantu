import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HK_M_SCENARIOS,
  armQaHostFloorOverride,
  hkMRamFloorOverrideActive,
  hkMScenarioFromEnv,
  hostFloorOverridden,
  qaHostFloorOverride,
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

const DEFAULT_USER_DATA = '/Library/Application Support/Metis'
const HOST = () => ({ hostTotalBytes: 7 * 1024 ** 3, hostAvailableBytes: 3 * 1024 ** 3 })

// M2-0482: M2-0460's HK-M lift is now a caller of the one qaHostFloorOverride gate; these pin that it still holds for
// exactly the HK-M rows and nothing else.
describe('HK-M RAM-floor override', () => {
  afterEach(() => {
    armQaHostFloorOverride({}, false, DEFAULT_USER_DATA)
  })

  it('starts the bundled model through ensureLocalRuntimeStarted with a minted override, text-only and ungated', async () => {
    const [modelId, vision, canStartSpeculatively, override] = await modelStartArgs()
    expect(modelId).toBe('qwen3.5-0.8b')
    expect(vision).toBe(false)
    expect(canStartSpeculatively).toBeUndefined()
    // The token counts only through the one gate: never before it is armed, and once it holds for an HK-M row.
    expect(hkMRamFloorOverrideActive(override, HK_M_ENV, true)).toBe(false)
    expect(armQaHostFloorOverride(HK_M_ENV, true, DEFAULT_USER_DATA)).toBe(true)
    expect(qaHostFloorOverride(HK_M_ENV, true, DEFAULT_USER_DATA)).toBe(true)
    expect(hkMRamFloorOverrideActive(override, HK_M_ENV, true)).toBe(true)
  })

  it('is inert unless packaged, on an isolated profile, and naming a known row', async () => {
    const [, , , override] = await modelStartArgs()
    const cases: Array<[NodeJS.ProcessEnv, boolean]> = [
      [HK_M_ENV, false],
      [{ METIS_HK_M_SCENARIO: 'model-starting' }, true],
      [{ ...HK_M_ENV, METIS_HK_M_SCENARIO: 'other' }, true],
      [{}, true]
    ]
    for (const [env, packaged] of cases) {
      armQaHostFloorOverride(env, packaged, DEFAULT_USER_DATA)
      expect(qaHostFloorOverride(env, packaged, DEFAULT_USER_DATA)).toBe(false)
      expect(hkMRamFloorOverrideActive(override, env, packaged)).toBe(false)
    }
  })

  it('counts no token outside an HK-M row, even with the gate armed by the explicit override env', async () => {
    const [, , , override] = await modelStartArgs()
    const env = { ASKTOTO_USERDATA: '/qa-profile', METIS_QA_HOST_FLOOR_OVERRIDE: '1' }
    expect(armQaHostFloorOverride(env, true, DEFAULT_USER_DATA)).toBe(true)
    expect(hkMRamFloorOverrideActive(override, env, true)).toBe(false)
  })

  it('cannot be passed by any other caller: a look-alike or missing token is ignored even inside the HK-M gate', async () => {
    const [, , , minted] = await modelStartArgs()
    armQaHostFloorOverride(HK_M_ENV, true, DEFAULT_USER_DATA)
    expect(hkMRamFloorOverrideActive({ ...(minted as object) }, HK_M_ENV, true)).toBe(false)
    expect(hkMRamFloorOverrideActive({ kind: 'hk-m-ram-floor' }, HK_M_ENV, true)).toBe(false)
    expect(hkMRamFloorOverrideActive(undefined, HK_M_ENV, true)).toBe(false)
    expect(hkMRamFloorOverrideActive(null, HK_M_ENV, true)).toBe(false)
  })

  it('cannot be passed by any other caller: without the armed gate no floor is lifted, whatever the env says', async () => {
    const [, , , minted] = await modelStartArgs()
    const audit = vi.fn()
    armQaHostFloorOverride({ ...HK_M_ENV, METIS_QA_HOST_FLOOR_OVERRIDE: '1' }, false, DEFAULT_USER_DATA)
    expect(hostFloorOverridden('advertised-ram', audit, HOST)).toBe(false)
    expect(hostFloorOverridden('prewarm-available-ram', audit, HOST)).toBe(false)
    expect(hkMRamFloorOverrideActive(minted, HK_M_ENV, true)).toBe(false)
    expect(audit).not.toHaveBeenCalled()
  })
})

describe('qaHostFloorOverride (M2-0482): the one RAM-floor override gate', () => {
  const QA_ENV = { ASKTOTO_USERDATA: '/qa-profile', METIS_QA_HOST_FLOOR_OVERRIDE: '1' }

  afterEach(() => {
    armQaHostFloorOverride({}, false, DEFAULT_USER_DATA)
  })

  it('holds for a packaged app on an isolated profile with the override env set exactly to 1', () => {
    expect(qaHostFloorOverride(QA_ENV, true, DEFAULT_USER_DATA)).toBe(true)
    for (const value of ['', '0', 'true', 'yes', '01', ' 1', '1 ']) {
      expect(qaHostFloorOverride({ ...QA_ENV, METIS_QA_HOST_FLOOR_OVERRIDE: value }, true, DEFAULT_USER_DATA)).toBe(false)
    }
  })

  it('never holds for an unpackaged app or without an isolated ASKTOTO_USERDATA profile', () => {
    expect(qaHostFloorOverride(QA_ENV, false, DEFAULT_USER_DATA)).toBe(false)
    expect(qaHostFloorOverride({ METIS_QA_HOST_FLOOR_OVERRIDE: '1' }, true, DEFAULT_USER_DATA)).toBe(false)
    expect(qaHostFloorOverride({ ...QA_ENV, ASKTOTO_USERDATA: '   ' }, true, DEFAULT_USER_DATA)).toBe(false)
  })

  it('never holds when ASKTOTO_USERDATA names the default userData path, however it is spelled', () => {
    const spellings = [DEFAULT_USER_DATA, `${DEFAULT_USER_DATA}/`, `${DEFAULT_USER_DATA}/../Metis`, DEFAULT_USER_DATA.toUpperCase()]
    for (const spelling of spellings) {
      expect(qaHostFloorOverride({ ...QA_ENV, ASKTOTO_USERDATA: spelling }, true, DEFAULT_USER_DATA)).toBe(false)
      expect(qaHostFloorOverride({ ...HK_M_ENV, ASKTOTO_USERDATA: spelling }, true, DEFAULT_USER_DATA)).toBe(false)
    }
  })

  it('holds for every known HK-M row without the explicit override env, and for no other row name', () => {
    for (const row of HK_M_SCENARIOS) {
      expect(qaHostFloorOverride({ ASKTOTO_USERDATA: '/qa-profile', METIS_HK_M_SCENARIO: row }, true, DEFAULT_USER_DATA)).toBe(true)
    }
    expect(qaHostFloorOverride({ ASKTOTO_USERDATA: '/qa-profile', METIS_HK_M_SCENARIO: 'Idle' }, true, DEFAULT_USER_DATA)).toBe(false)
  })

  it('is the only decision: the armed floor lift equals the gate for every input combination', () => {
    const envs: NodeJS.ProcessEnv[] = [
      {},
      QA_ENV,
      HK_M_ENV,
      { ...QA_ENV, METIS_QA_HOST_FLOOR_OVERRIDE: 'true' },
      { ...QA_ENV, ASKTOTO_USERDATA: DEFAULT_USER_DATA },
      { METIS_QA_HOST_FLOOR_OVERRIDE: '1', METIS_HK_M_SCENARIO: 'idle' }
    ]
    for (const env of envs) {
      for (const packaged of [true, false]) {
        const armed = armQaHostFloorOverride(env, packaged, DEFAULT_USER_DATA)
        expect(armed).toBe(qaHostFloorOverride(env, packaged, DEFAULT_USER_DATA))
        expect(hostFloorOverridden('advertised-ram', vi.fn(), HOST)).toBe(armed)
        expect(hostFloorOverridden('prewarm-available-ram', vi.fn(), HOST)).toBe(armed)
      }
    }
  })

  it('audits the first lift of each floor once per process, content-free, and never while disarmed', () => {
    const audit = vi.fn()
    expect(hostFloorOverridden('advertised-ram', audit, HOST)).toBe(false)
    expect(audit).not.toHaveBeenCalled()

    armQaHostFloorOverride(QA_ENV, true, DEFAULT_USER_DATA)
    expect(hostFloorOverridden('advertised-ram', audit, HOST)).toBe(true)
    expect(hostFloorOverridden('advertised-ram', audit, HOST)).toBe(true)
    expect(hostFloorOverridden('prewarm-available-ram', audit, HOST)).toBe(true)
    expect(hostFloorOverridden('prewarm-available-ram', audit, HOST)).toBe(true)
    expect(audit.mock.calls).toEqual([
      ['local.host-floor-override', { floor: 'advertised-ram', hostTotalBytes: 7 * 1024 ** 3, hostAvailableBytes: 3 * 1024 ** 3 }],
      ['local.host-floor-override', { floor: 'prewarm-available-ram', hostTotalBytes: 7 * 1024 ** 3, hostAvailableBytes: 3 * 1024 ** 3 }]
    ])
  })

  it('copies only the two memory figures into the audit detail', () => {
    const audit = vi.fn()
    armQaHostFloorOverride(QA_ENV, true, DEFAULT_USER_DATA)
    const leaky = () => ({ hostTotalBytes: 1, hostAvailableBytes: 2, path: '/qa-profile/model.gguf' })
    hostFloorOverridden('advertised-ram', audit, leaky)
    expect(audit).toHaveBeenCalledWith('local.host-floor-override', { floor: 'advertised-ram', hostTotalBytes: 1, hostAvailableBytes: 2 })
  })
})
