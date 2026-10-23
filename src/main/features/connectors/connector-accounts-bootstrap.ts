import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { authStatus, getGraphToken } from '../../auth'
import type { OwnerSessionAuthority } from '../../lifecycle/owner-session-authority'
import { createFileConnectorAccountStore } from './account-store'
import type { ConnectorAccountStore } from './account-store'
import type { ConnectorAccountVerificationSignal } from './account-registry'
import { createConnectorAccountRegistry } from './account-registry'
import { registerConnectorAccountsIpc } from './connector-accounts-ipc'
import { configureConnectorAccountRuntime } from './connector-runtime'

export interface ConnectorAccountsBootstrapDeps {
  ipcMain: Pick<IpcMain, 'handle'>
  assertMainWindow(event: IpcMainInvokeEvent): void
  requireAuth(): boolean
  ownerSession: Pick<OwnerSessionAuthority, 'currentOwnerKey' | 'currentTenantKey' | 'onRevoked'>
  userDataPath(): string
  onWillQuit(listener: () => void): void
  /** Test seam; production reads only the signed-in main-process auth session. */
  identity?(): { signedIn: boolean; email?: string }
  /** Test seams; production persists to userData and verifies against the main-process Graph token cache. */
  accountStore?: ConnectorAccountStore
  verifyCurrentIdentity?(): Promise<string | null>
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
      const token = await (deps.verifyCurrentIdentity ?? (() => getGraphToken(['User.Read'])))()
      signal = token ? 'token_refresh_succeeded' : 'token_refresh_rejected'
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

  deps.ownerSession.onRevoked((ref, reason) => {
    if (reason !== 'sign-out' && reason !== 'auth-changed') return
    void registry.disconnectOwnerAccounts({ ownerKey: ref.ownerKey, tenantKey: ref.tenantKey })
  })
  deps.onWillQuit(() => {
    void registry.pausePendingFlows('app_quit')
  })

  return { registry, ensureCurrentAccount }
}
