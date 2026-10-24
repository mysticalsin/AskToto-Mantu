import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import {
  CONNECTOR_ACCOUNTS_IPC,
  ConnectorAccountListPayloadSchema,
  ConnectorAccountListResponseSchema,
  ConnectorOnboardingBeginPayloadSchema,
  ConnectorOnboardingFlowPayloadSchema,
  ConnectorOnboardingListPayloadSchema,
  ConnectorOnboardingListResponseSchema,
  ConnectorOnboardingMutationResponseSchema
} from '@shared/connector-accounts'
import type { ConnectorAccountRegistry } from './account-registry'

export interface ConnectorAccountsIpcDeps {
  assertMainWindow(event: IpcMainInvokeEvent): void
  requireAuth(): boolean
  registry: Pick<
    ConnectorAccountRegistry,
    | 'prepareCurrentScope'
    | 'listViews'
    | 'listOnboardingFlows'
    | 'beginOnboarding'
    | 'resumeOnboarding'
    | 'abandonOnboarding'
  >
  /** Main-only identity synchronization; it creates a connecting record and never marks it healthy. */
  ensureCurrentAccount?(): Promise<unknown>
}

export function registerConnectorAccountsIpc(ipcMain: Pick<IpcMain, 'handle'>, deps: ConnectorAccountsIpcDeps): void {
  const gate = (event: IpcMainInvokeEvent): boolean => {
    deps.assertMainWindow(event)
    return deps.requireAuth()
  }

  ipcMain.handle(CONNECTOR_ACCOUNTS_IPC.list, async (event: IpcMainInvokeEvent, raw: unknown) => {
    if (!gate(event)) return { ok: false, error: 'auth_required' } as const
    if (!ConnectorAccountListPayloadSchema.safeParse(raw).success) return { ok: false, error: 'invalid_input' } as const
    await deps.registry.prepareCurrentScope()
    await deps.ensureCurrentAccount?.()
    return ConnectorAccountListResponseSchema.parse({ ok: true, accounts: await deps.registry.listViews() })
  })

  ipcMain.handle(CONNECTOR_ACCOUNTS_IPC.listOnboarding, async (event: IpcMainInvokeEvent, raw: unknown) => {
    if (!gate(event)) return { ok: false, error: 'auth_required' } as const
    if (!ConnectorOnboardingListPayloadSchema.safeParse(raw).success) {
      return { ok: false, error: 'invalid_input' } as const
    }
    await deps.registry.prepareCurrentScope()
    return ConnectorOnboardingListResponseSchema.parse({ ok: true, flows: await deps.registry.listOnboardingFlows() })
  })

  ipcMain.handle(CONNECTOR_ACCOUNTS_IPC.begin, async (event: IpcMainInvokeEvent, raw: unknown) => {
    if (!gate(event)) return { ok: false, error: 'auth_required' } as const
    const input = ConnectorOnboardingBeginPayloadSchema.safeParse(raw)
    if (!input.success) return { ok: false, error: 'invalid_input' } as const
    await deps.registry.prepareCurrentScope()
    const flow = await deps.registry.beginOnboarding(input.data)
    return ConnectorOnboardingMutationResponseSchema.parse({ ok: true, flow })
  })

  const mutate = async (
    event: IpcMainInvokeEvent,
    raw: unknown,
    action: (flowId: string) => ReturnType<ConnectorAccountRegistry['resumeOnboarding']>
  ) => {
    if (!gate(event)) return { ok: false, error: 'auth_required' } as const
    const input = ConnectorOnboardingFlowPayloadSchema.safeParse(raw)
    if (!input.success) return { ok: false, error: 'invalid_input' } as const
    await deps.registry.prepareCurrentScope()
    const result = await action(input.data.flowId)
    if (!result.ok) {
      return ConnectorOnboardingMutationResponseSchema.parse({ ok: false, error: result.reason })
    }
    return ConnectorOnboardingMutationResponseSchema.parse({ ok: true, flow: result.flow })
  }

  ipcMain.handle(CONNECTOR_ACCOUNTS_IPC.resume, (event: IpcMainInvokeEvent, raw: unknown) =>
    mutate(event, raw, (flowId) => deps.registry.resumeOnboarding(flowId))
  )
  ipcMain.handle(CONNECTOR_ACCOUNTS_IPC.abandon, (event: IpcMainInvokeEvent, raw: unknown) =>
    mutate(event, raw, (flowId) => deps.registry.abandonOnboarding(flowId))
  )
}
