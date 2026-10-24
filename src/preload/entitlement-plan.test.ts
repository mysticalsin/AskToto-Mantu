import { describe, expect, it, vi } from 'vitest'
import { ENTITLEMENT_IPC } from '@shared/entitlement-ipc'
import { createEntitlementPlanPreloadApi } from './entitlement-plan'

describe('entitlement plan preload API', () => {
  it('getOperatorPlan invokes ENTITLEMENT_IPC.planGet', async () => {
    const invoke = vi.fn(async () => ({ state: 'checking' }))
    const api = createEntitlementPlanPreloadApi({ invoke } as never)
    await expect(api.getOperatorPlan()).resolves.toEqual({ state: 'checking' })
    expect(invoke.mock.calls).toEqual([[ENTITLEMENT_IPC.planGet]])
  })
})
