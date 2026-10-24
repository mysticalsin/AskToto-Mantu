import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { ENTITLEMENT_IPC } from '@shared/entitlement-ipc'
import { IPC } from '@shared/ipc'
import type { OperatorPlan } from '@shared/operator-plan'

interface OperatorReportingIpcDependencies {
  ipcMain: Pick<IpcMain, 'handle'>
  assertMainWindow: (event: IpcMainInvokeEvent) => void
  snapshot: () => { status: string; origin: string | null; state: string }
  requireAuth: () => boolean
  planSnapshot: () => OperatorPlan
}

/** What a signed-out window sees: no tier, entitlements or meters. */
export const SIGNED_OUT_PLAN: OperatorPlan = {
  state: 'unmanaged',
  tier: null,
  lastKnownTier: null,
  entitlements: null,
  managedAi: false,
  meters: []
}

/** What a signed-out window sees from the Operator status channel: nothing configured, nothing granted. */
export const OPERATOR_STATUS_SIGNED_OUT = {
  configured: false,
  tier: null,
  entitlements: null,
  licenseLast4: '',
  licenseExpiresAt: null,
  integrations: [],
  mcpServers: []
} as const

/** Organisation reporting state for Settings and onboarding. Status, origin and state only, never a credential. */
export function registerOperatorReportingIpc(deps: OperatorReportingIpcDependencies): void {
  deps.ipcMain.handle(IPC.operatorReportingStatus, (event) => {
    deps.assertMainWindow(event)
    return deps.snapshot()
  })
  // Read-only plan for Settings (G79): checking / licensed / stale plus server-defined meters. No credential.
  deps.ipcMain.handle(ENTITLEMENT_IPC.planGet, (event) => {
    deps.assertMainWindow(event)
    return deps.requireAuth() ? deps.planSnapshot() : SIGNED_OUT_PLAN
  })
}
