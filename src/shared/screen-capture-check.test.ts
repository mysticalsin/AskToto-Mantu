import { describe, expect, it } from 'vitest'
import type { ProviderId } from './providers'
import {
  formatProbeMessage,
  formatVisionMessage,
  interpretVisionReply,
  isApiVisionCandidate,
  nextScreenCheckPass,
  pickVisionBackends,
  planScreenCaptureCheck,
  type VisionCheckContext
} from './screen-capture-check'

const localFirst: VisionCheckContext = {
  localWeightsReady: true,
  localEnabled: true,
  apiVisionReady: true,
  activeProvider: 'local'
}

const onDust: VisionCheckContext = {
  localWeightsReady: true,
  localEnabled: true,
  apiVisionReady: true,
  activeProvider: 'dust'
}

function ctx(partial: Partial<VisionCheckContext> & Pick<VisionCheckContext, 'activeProvider'>): VisionCheckContext {
  return {
    localWeightsReady: false,
    localEnabled: false,
    apiVisionReady: false,
    ...partial
  }
}

describe('nextScreenCheckPass — first is probe, second is vision', () => {
  it('the first check is the OS probe', () => {
    expect(nextScreenCheckPass(null)).toBe('probe')
  })

  it('the second check is vision, never another probe', () => {
    expect(nextScreenCheckPass('probe')).toBe('vision')
    expect(nextScreenCheckPass('vision')).toBe('vision')
  })
})

describe('planScreenCaptureCheck — probe-only is not the second check', () => {
  it('the first pass is probe-only (no model backends)', () => {
    expect(planScreenCaptureCheck('probe', localFirst)).toEqual({ pass: 'probe' })
    expect(planScreenCaptureCheck('probe', onDust)).toEqual({ pass: 'probe' })
  })

  it('the second pass is a vision plan, not a probe', () => {
    const plan = planScreenCaptureCheck('vision', localFirst)
    expect(plan.pass).toBe('vision')
    expect(plan).not.toEqual({ pass: 'probe' })
    if (plan.pass !== 'vision') throw new Error('expected vision plan')
    expect(plan.primary).not.toBeNull()
  })
})

describe('pickVisionBackends — second check calls local or API', () => {
  it('local-first when weights are present and the active provider is local', () => {
    expect(pickVisionBackends(localFirst)).toEqual({ primary: 'local', failover: 'api' })
  })

  it('API-first when he is on a vision-capable API (Dust included)', () => {
    expect(pickVisionBackends(onDust)).toEqual({ primary: 'api', failover: 'local' })
    expect(isApiVisionCandidate('dust', true, true)).toBe(true)
  })

  it('local-only when weights are present and no API is ready', () => {
    expect(pickVisionBackends(ctx({ activeProvider: 'local', localWeightsReady: true }))).toEqual({
      primary: 'local',
      failover: null
    })
  })

  it('API-only when local weights are missing', () => {
    expect(pickVisionBackends(ctx({ activeProvider: 'anthropic', apiVisionReady: true }))).toEqual({
      primary: 'api',
      failover: null
    })
  })

  it('does not fail over to local when he is on API but Local AI is off', () => {
    expect(
      pickVisionBackends(
        ctx({
          activeProvider: 'dust' as ProviderId,
          apiVisionReady: true,
          localWeightsReady: true,
          localEnabled: false
        })
      )
    ).toEqual({ primary: 'api', failover: null })
  })

  it('failover is at most one backend', () => {
    const a = pickVisionBackends(localFirst)
    const b = pickVisionBackends(onDust)
    expect(a.failover === null || a.failover !== a.primary).toBe(true)
    expect(b.failover === null || b.failover !== b.primary).toBe(true)
    expect([a.failover, b.failover].every((x) => x === null || x === 'local' || x === 'api')).toBe(true)
  })

  it('loud no-backend when nothing vision-capable is ready', () => {
    expect(pickVisionBackends(ctx({ activeProvider: 'kimi' }))).toEqual({ primary: null, failover: null })
  })
})

describe('interpretVisionReply — fail loud if the model cannot see the shot', () => {
  it('passes on VISION_OK plus a visible-thing description', () => {
    expect(interpretVisionReply('VISION_OK a Settings window with a gear')).toMatchObject({
      sawShot: true
    })
  })

  it('fails on VISION_FAIL, empty, or a refusal', () => {
    expect(interpretVisionReply('VISION_FAIL').sawShot).toBe(false)
    expect(interpretVisionReply('').sawShot).toBe(false)
    expect(interpretVisionReply('I cannot see any image in this request.').sawShot).toBe(false)
  })

  it('fails on a bare OK with no evidence the model saw pixels', () => {
    expect(interpretVisionReply('VISION_OK').sawShot).toBe(false)
    expect(interpretVisionReply('ok').sawShot).toBe(false)
  })

  it('accepts a concrete visual description that skipped the token', () => {
    expect(interpretVisionReply('A dark Settings panel with a camera icon is visible on screen.').sawShot).toBe(
      true
    )
  })
})

describe('format messages name the backend on success and stay loud on fail', () => {
  it('probe success tells the user to check again with a model', () => {
    expect(formatProbeMessage(true)).toMatch(/OS probe/i)
    expect(formatProbeMessage(true)).toMatch(/Check again/i)
    expect(formatProbeMessage(false)).toMatch(/failed/i)
  })

  it('vision success names which backend answered', () => {
    expect(formatVisionMessage({ ok: true, backendLabel: 'Métis Local · on-device' })).toBe(
      'Métis Local · on-device can see the screen.'
    )
    expect(formatVisionMessage({ ok: true, backendLabel: 'Dust', failedOver: true })).toMatch(/after the other backend failed/)
  })

  it('vision failure is loud and names the gap', () => {
    expect(formatVisionMessage({ ok: false, noBackend: true })).toMatch(/No vision-capable/)
    expect(formatVisionMessage({ ok: false, backendLabel: 'Dust', reason: 'VISION_FAIL' })).toMatch(/could not see/)
  })
})
