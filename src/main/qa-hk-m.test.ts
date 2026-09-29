import { describe, expect, it, vi } from 'vitest'
import { HK_M_SCENARIOS, hkMScenarioFromEnv, runHkMScenario, type HkMDeps } from './qa-hk-m'

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
