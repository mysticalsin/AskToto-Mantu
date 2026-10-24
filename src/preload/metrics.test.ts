import { describe, expect, it, vi } from 'vitest'
import { IPC } from '../shared/ipc'
import { RESPONSIVENESS_IPC } from '../shared/responsiveness-metrics'
import { readModuleSource } from '../test-helpers/module-source'
import { createMetricsPreloadApi } from './metrics'

describe('metrics preload bridge', () => {
  it('reads the eval metrics, the responsiveness report and sends a display receipt over their own channels', async () => {
    const invoke = vi.fn(async (channel: string) => ({ channel }))
    const api = createMetricsPreloadApi({ invoke })
    await expect(api.readMetrics()).resolves.toEqual({ channel: IPC.metricsRead })
    await expect(api.readResponsiveness()).resolves.toEqual({ channel: RESPONSIVENESS_IPC.report })
    await api.reportDisplayReceipt('ask-1')
    expect(invoke).toHaveBeenLastCalledWith(RESPONSIVENESS_IPC.displayReceipt, 'ask-1')
  })

  it('never rejects a display receipt: a lost receipt is a missing count, not a UI error', async () => {
    const invoke = vi.fn(async () => {
      throw new Error('synthetic ipc failure')
    })
    const api = createMetricsPreloadApi({ invoke })
    await expect(api.reportDisplayReceipt('ask-1')).resolves.toBeUndefined()
  })

  it('reportCardOutcome invokes metrics:card-outcome with only the ask id and the outcome', async () => {
    const invoke = vi.fn(async () => undefined)
    const api = createMetricsPreloadApi({ invoke })
    await api.reportCardOutcome('ask-1', 'duplicate_rolled_back')
    expect(invoke).toHaveBeenLastCalledWith('metrics:card-outcome', 'ask-1', 'duplicate_rolled_back')
  })

  it('swallows a rejected invoke', async () => {
    const invoke = vi.fn(async () => {
      throw new Error('synthetic ipc failure')
    })
    const api = createMetricsPreloadApi({ invoke })
    await expect(api.reportCardOutcome('ask-1', 'review_expired')).resolves.toBeUndefined()
  })

  it('is spread into the window.toto bridge, and the inline readMetrics it replaced is gone', () => {
    // index.ts composes the self-contained feature bridges through feature-apis.ts (V02), which spreads this one.
    const { text } = readModuleSource(__dirname, './index')
    expect(text).toMatch(/\.\.\.createFeaturePreloadApis\(ipcRenderer\)/)
    expect(text).not.toMatch(/readMetrics:/)
    const features = readModuleSource(__dirname, './feature-apis').text
    expect(features).toMatch(/\.\.\.createMetricsPreloadApi\(ipc\)/)
  })
})
