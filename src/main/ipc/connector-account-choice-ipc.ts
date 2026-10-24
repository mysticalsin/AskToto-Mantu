import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import {
  ACCOUNT_CHOICE_IPC,
  AccountChoiceCancellationSchema,
  AccountChoiceDecisionSchema,
  type AccountChoiceState
} from '@shared/connector-account-choice'
import type { AccountChoiceBroker } from '../features/connectors/account-choice-broker'

export interface AccountChoiceIpcDeps {
  assertMainWindow(event: IpcMainInvokeEvent): void
  requireAuth(): boolean
  broker: Pick<AccountChoiceBroker, 'current' | 'decide' | 'cancel'>
}

/**
 * The ambiguity choice card's IPC (G62). Every handler sits behind the main-window sender check and acts only for the
 * calling window: the owner comes from the IPC sender, never from the payload. The payload names the card (opaque id,
 * nonce, args hash) and the account the person picked; main validates all of it again.
 */
export function registerAccountChoiceIpc(ipcMain: Pick<IpcMain, 'handle'>, deps: AccountChoiceIpcDeps): void {
  ipcMain.handle(ACCOUNT_CHOICE_IPC.current, (event: IpcMainInvokeEvent): AccountChoiceState => {
    deps.assertMainWindow(event)
    return deps.requireAuth() ? deps.broker.current(event.sender.id) : { choiceId: null }
  })
  ipcMain.handle(ACCOUNT_CHOICE_IPC.decide, async (event: IpcMainInvokeEvent, raw: unknown) => {
    deps.assertMainWindow(event)
    if (!deps.requireAuth()) return { ok: false, reason: 'auth_required' } as const
    const parsed = AccountChoiceDecisionSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, reason: 'invalid_input' } as const
    return deps.broker.decide({ ...parsed.data, webContentsId: event.sender.id })
  })
  ipcMain.handle(ACCOUNT_CHOICE_IPC.cancel, (event: IpcMainInvokeEvent, raw: unknown) => {
    deps.assertMainWindow(event)
    const parsed = AccountChoiceCancellationSchema.safeParse(raw)
    return { ok: parsed.success && deps.broker.cancel({ ...parsed.data, webContentsId: event.sender.id }) }
  })
}
