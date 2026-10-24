import type { IpcRenderer } from 'electron'
import { ENTITLEMENT_IPC } from '../shared/entitlement-ipc'
import type { OperatorPlan } from '../shared/operator-plan'

/** Operator plan bridge (G79): read-only plan state, server meters and the managed-AI flag for Settings. */
export function createEntitlementPlanPreloadApi(ipc: Pick<IpcRenderer, 'invoke'>): {
  getOperatorPlan(): Promise<OperatorPlan>
} {
  return {
    getOperatorPlan: () => ipc.invoke(ENTITLEMENT_IPC.planGet)
  }
}
