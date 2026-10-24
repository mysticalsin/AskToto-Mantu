import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import {
  CONNECTOR_CONFIRM_IPC,
  ConnectorConfirmCancellationSchema,
  ConnectorConfirmDecisionSchema,
  type ConnectorConfirmState
} from '@shared/connector-confirm'
import type { ConnectorConfirmBroker } from '../features/connectors/connector-confirm-broker'

export interface ConnectorConfirmIpcDeps {
  assertMainWindow(event: IpcMainInvokeEvent): void
  requireAuth(): boolean
  broker: Pick<ConnectorConfirmBroker, 'current' | 'decide' | 'cancel'>
}

/**
 * The connector confirm card's IPC (G64). Every handler sits behind the main-window sender check and acts only for the
 * calling window: the owner comes from the IPC sender, never from the payload. Without a signed-in session no card
 * is returned and no decision is accepted.
 */
export function registerConnectorConfirmIpc(ipcMain: Pick<IpcMain, 'handle'>, deps: ConnectorConfirmIpcDeps): void {
  ipcMain.handle(CONNECTOR_CONFIRM_IPC.current, (event: IpcMainInvokeEvent): ConnectorConfirmState => {
    deps.assertMainWindow(event)
    return deps.requireAuth() ? deps.broker.current(event.sender.id) : { proposalId: null }
  })
  ipcMain.handle(CONNECTOR_CONFIRM_IPC.decide, (event: IpcMainInvokeEvent, raw: unknown) => {
    deps.assertMainWindow(event)
    if (!deps.requireAuth()) return { ok: false, reason: 'auth_required' } as const
    const parsed = ConnectorConfirmDecisionSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, reason: 'invalid_input' } as const
    return deps.broker.decide({ ...parsed.data, webContentsId: event.sender.id })
  })
  ipcMain.handle(CONNECTOR_CONFIRM_IPC.cancel, (event: IpcMainInvokeEvent, raw: unknown) => {
    deps.assertMainWindow(event)
    const parsed = ConnectorConfirmCancellationSchema.safeParse(raw)
    return { ok: parsed.success && deps.broker.cancel({ ...parsed.data, webContentsId: event.sender.id }) }
  })
}
