import { describe, expect, it, vi } from 'vitest'
import { collectVisionStream, runScreenCaptureCheck, type ScreenCaptureCheckDeps } from './screen-capture-check'
import type { VisionCheckContext } from '@shared/screen-capture-check'

const localCtx: VisionCheckContext = {
  localWeightsReady: true,
  localEnabled: true,
  apiVisionReady: true,
  activeProvider: 'local'
}

const apiCtx: VisionCheckContext = {
  localWeightsReady: true,
  localEnabled: true,
  apiVisionReady: true,
  activeProvider: 'dust'
}

function deps(overrides: Partial<ScreenCaptureCheckDeps> = {}): ScreenCaptureCheckDeps {
  return {
    probe: vi.fn(async () => true),
    capture: vi.fn(async () => ({ image: 'dGVzdA==' })),
    askVision: vi.fn(async (backend) => ({
      text: 'VISION_OK a Settings window',
      label: backend === 'local' ? 'Métis Local · on-device' : 'Dust'
    })),
    context: localCtx,
    ...overrides
  }
}

describe('collectVisionStream', () => {
  it('joins deltas and does not paint an overlay ask', async () => {
    const text = await collectVisionStream((handlers) => {
      handlers.onDelta('VISION_OK ')
      handlers.onDelta('a gear icon')
      handlers.onDone()
      return { abort: vi.fn() }
    })
    expect(text).toBe('VISION_OK a gear icon')
  })
})

describe('runScreenCaptureCheck — probe-only is not the second check', () => {
  it('the probe pass only calls probe, never capture or a model', async () => {
    const d = deps()
    const result = await runScreenCaptureCheck('probe', d)
    expect(result.pass).toBe('probe')
    expect(result.backend).toBe('probe')
    expect(d.probe).toHaveBeenCalledOnce()
    expect(d.capture).not.toHaveBeenCalled()
    expect(d.askVision).not.toHaveBeenCalled()
  })

  it('the vision pass never calls the OS probe', async () => {
    const d = deps()
    const result = await runScreenCaptureCheck('vision', d)
    expect(result.pass).toBe('vision')
    expect(result.ok).toBe(true)
    expect(d.probe).not.toHaveBeenCalled()
    expect(d.capture).toHaveBeenCalledOnce()
    expect(d.askVision).toHaveBeenCalled()
  })
})

describe('runScreenCaptureCheck — second check calls local or API', () => {
  it('asks Local AI first when weights are present and the active provider is local', async () => {
    const d = deps()
    const result = await runScreenCaptureCheck('vision', d)
    expect(d.askVision).toHaveBeenCalledWith('local', 'dGVzdA==')
    expect(result.backend).toBe('local')
    expect(result.message).toMatch(/Métis Local/)
    expect(result.failedOver).toBe(false)
  })

  it('asks the configured API first when he is on Dust', async () => {
    const d = deps({ context: apiCtx })
    const result = await runScreenCaptureCheck('vision', d)
    expect(d.askVision).toHaveBeenCalledWith('api', 'dGVzdA==')
    expect(result.backend).toBe('api')
    expect(result.message).toMatch(/Dust/)
  })

  it('fails loud when no vision backend is ready — still not a probe', async () => {
    const d = deps({
      context: {
        localWeightsReady: false,
        localEnabled: false,
        apiVisionReady: false,
        activeProvider: 'kimi'
      }
    })
    const result = await runScreenCaptureCheck('vision', d)
    expect(result.ok).toBe(false)
    expect(result.pass).toBe('vision')
    expect(result.message).toMatch(/No vision-capable/)
    expect(d.probe).not.toHaveBeenCalled()
    expect(d.capture).not.toHaveBeenCalled()
    expect(d.askVision).not.toHaveBeenCalled()
  })

  it('fails loud when the model cannot see the shot and there is no failover', async () => {
    const d = deps({
      context: { ...localCtx, apiVisionReady: false },
      askVision: vi.fn(async () => ({ text: 'VISION_FAIL', label: 'Métis Local · on-device' }))
    })
    const result = await runScreenCaptureCheck('vision', d)
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/could not see/)
    expect(d.askVision).toHaveBeenCalledOnce()
  })
})

describe('runScreenCaptureCheck — failover once', () => {
  it('falls over to API once when local cannot see the shot', async () => {
    const askVision = vi.fn(async (backend: 'local' | 'api') => {
      if (backend === 'local') return { text: 'VISION_FAIL', label: 'Métis Local · on-device' }
      return { text: 'VISION_OK a dark overlay bar', label: 'Dust' }
    })
    const d = deps({ askVision })
    const result = await runScreenCaptureCheck('vision', d)
    expect(askVision).toHaveBeenCalledTimes(2)
    expect(askVision.mock.calls[0][0]).toBe('local')
    expect(askVision.mock.calls[1][0]).toBe('api')
    expect(result.ok).toBe(true)
    expect(result.backend).toBe('api')
    expect(result.failedOver).toBe(true)
    expect(result.message).toMatch(/Dust/)
    expect(result.message).toMatch(/after the other backend failed/)
  })

  it('falls over to local once when he is on API and local is enabled', async () => {
    const askVision = vi.fn(async (backend: 'local' | 'api') => {
      if (backend === 'api') throw new Error('Dust agent rejected the image')
      return { text: 'VISION_OK the Permissions card', label: 'Métis Local · on-device' }
    })
    const d = deps({ context: apiCtx, askVision })
    const result = await runScreenCaptureCheck('vision', d)
    expect(askVision).toHaveBeenCalledTimes(2)
    expect(askVision.mock.calls[0][0]).toBe('api')
    expect(askVision.mock.calls[1][0]).toBe('local')
    expect(result.ok).toBe(true)
    expect(result.backend).toBe('local')
    expect(result.failedOver).toBe(true)
  })

  it('does not try a third backend after one failover', async () => {
    const askVision = vi.fn(async () => ({ text: 'VISION_FAIL', label: 'nope' }))
    const d = deps({ askVision })
    const result = await runScreenCaptureCheck('vision', d)
    expect(askVision).toHaveBeenCalledTimes(2)
    expect(result.ok).toBe(false)
    expect(result.failedOver).toBe(true)
    expect(result.message).toMatch(/could not see/)
  })

  it('does not ask a model when capture itself fails', async () => {
    const d = deps({
      capture: vi.fn(async () => {
        throw new Error('Private View is on — screen capture is blocked.')
      })
    })
    const result = await runScreenCaptureCheck('vision', d)
    expect(result.ok).toBe(false)
    expect(d.askVision).not.toHaveBeenCalled()
    expect(result.message).toMatch(/Private View/)
  })
})
