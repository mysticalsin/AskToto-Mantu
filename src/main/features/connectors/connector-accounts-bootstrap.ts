import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { authStatus, getGraphTokenOutcome } from '../../auth'
import type { GraphTokenOutcome } from '../../auth-graph-token-outcome'
import type { OwnerSessionAuthority } from '../../lifecycle/owner-session-authority'
import { createFileConnectorAccountStore } from './account-store'
import type { ConnectorAccountStore } from './account-store'
import type { ConnectorAccountVerificationSignal } from './account-registry'
import { createConnectorAccountRegistry } from './account-registry'
import { ACCOUNT_CHOICE_IPC, type AccountChoiceState } from '@shared/connector-account-choice'
import { CONNECTOR_CONFIRM_IPC, type ConnectorConfirmState } from '@shared/connector-confirm'
import { registerAccountChoiceIpc } from '../../ipc/connector-account-choice-ipc'
import { registerConnectorConfirmIpc } from '../../ipc/connector-confirm-ipc'
import { registerConnectorAccountsIpc } from '../../ipc/connector-accounts-ipc'
import {
  accountChoiceBroker,
  configureAccountChoiceDelivery,
  configureConnectorAccountRuntime,
  configureConnectorConfirmDelivery,
  connectorCatalog,
  connectorConfirmBroker
} from './connector-runtime'
import { auditLog } from '../../logger'
import { configureMcpCallRuntime, createMcpCallRuntime } from './mcp-call-runtime'

export interface ConnectorAccountsBootstrapDeps {
  ipcMain: Pick<IpcMain, 'handle'>
  assertMainWindow(event: IpcMainInvokeEvent): void
  requireAuth(): boolean
  ownerSession: Pick<OwnerSessionAuthority, 'currentOwnerKey' | 'currentTenantKey' | 'onRevoked'>
  userDataPath(): string
  onWillQuit(listener: () => void): void
  /** How an account choice card reaches its owner window (production: `webContents.fromId(id)?.send`). */
  sendToWebContents?(webContentsId: number, channel: string, state: AccountChoiceState | ConnectorConfirmState): void
  /** Test seam; production reads only the signed-in main-process auth session. */
  identity?(): { signedIn: boolean; email?: string }
  /** Test seams; production persists to userData and verifies against the main-process Graph token cache. */
  accountStore?: ConnectorAccountStore
  verifyCurrentIdentity?(): Promise<GraphTokenOutcome>
}

/** Main-only connector account lifecycle: owner/tenant partition, registry, safe account-view IPC and G60 executor. */
export function bootstrapConnectorAccounts(deps: ConnectorAccountsBootstrapDeps) {
  const registry = createConnectorAccountRegistry({
    currentScope: () => {
      const ownerKey = deps.ownerSession.currentOwnerKey()
      const tenantKey = deps.ownerSession.currentTenantKey()
      return ownerKey && tenantKey ? { ownerKey, tenantKey } : null
    },
    store: deps.accountStore ?? createFileConnectorAccountStore(deps.userDataPath)
  })

  const ensureCurrentAccount = async (kind: Parameters<typeof registry.ensureAccount>[0]['kind']) => {
    if (!deps.requireAuth()) return null
    const identity = (deps.identity ?? authStatus)()
    if (!identity.signedIn || !identity.email) return null
    await registry.prepareCurrentScope()
    const accountRef = await registry.ensureAccount({ kind, providerAccountId: identity.email })
    const pendingFlows = (await registry.listOnboardingFlows()).filter(
      (flow) => flow.kind === kind && flow.status === 'pending'
    )
    if (pendingFlows.length !== 1) return accountRef
    const [pendingFlow] = pendingFlows
    if (!pendingFlow) return accountRef

    let signal: ConnectorAccountVerificationSignal
    try {
      const outcome = await (deps.verifyCurrentIdentity ?? (() => getGraphTokenOutcome(['User.Read'])))()
      signal = outcome.ok
        ? 'token_refresh_succeeded'
        : outcome.reason === 'transient'
          ? 'token_refresh_transient'
          : 'token_refresh_rejected'
    } catch {
      signal = 'token_refresh_transient'
    }
    await registry.completeOnboarding(pendingFlow.flowId, { kind, providerAccountId: identity.email }, signal)
    return accountRef
  }

  configureConnectorAccountRuntime({ registry, ensureCurrentAccount })
  registerConnectorAccountsIpc(deps.ipcMain, {
    assertMainWindow: deps.assertMainWindow,
    requireAuth: deps.requireAuth,
    registry,
    ensureCurrentAccount: async () => {
      await ensureCurrentAccount('outlook')
    }
  })

  const sendToWebContents = deps.sendToWebContents
  configureAccountChoiceDelivery(
    sendToWebContents ? (id, state) => sendToWebContents(id, ACCOUNT_CHOICE_IPC.state, state) : null
  )
  registerAccountChoiceIpc(deps.ipcMain, {
    assertMainWindow: deps.assertMainWindow,
    requireAuth: deps.requireAuth,
    broker: accountChoiceBroker()
  })
  configureConnectorConfirmDelivery(
    sendToWebContents ? (id, state) => sendToWebContents(id, CONNECTOR_CONFIRM_IPC.state, state) : null
  )
  configureMcpCallRuntime(
    createMcpCallRuntime({
      confirm: connectorConfirmBroker(),
      catalogRevision: () => connectorCatalog.current().revision,
      audit: (event, metadata) => auditLog(event as never, metadata as never)
    })
  )
  registerConnectorConfirmIpc(deps.ipcMain, {
    assertMainWindow: deps.assertMainWindow,
    requireAuth: deps.requireAuth,
    broker: connectorConfirmBroker()
  })

  deps.ownerSession.onRevoked((ref, reason) => {
    if (reason !== 'sign-out' && reason !== 'auth-changed') return
    // A pending account choice belongs to the session that raised it: it never resumes under another owner.
    accountChoiceBroker().revokeAll(reason)
    connectorConfirmBroker().revokeAll(reason)
    void registry.disconnectOwnerAccounts({ ownerKey: ref.ownerKey, tenantKey: ref.tenantKey })
  })
  deps.onWillQuit(() => {
    void registry.pausePendingFlows('app_quit')
  })

  return { registry, ensureCurrentAccount }
}
