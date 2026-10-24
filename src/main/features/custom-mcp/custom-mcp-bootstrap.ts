import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { OwnerSessionAuthority } from '../../lifecycle/owner-session-authority'
import { auditLog } from '../../logger'
import { clearMcpApiKey, getMcpApiKey, hasMcpApiKey, setMcpApiKey } from '../../mcp/mcpSecrets'
import { registerCustomMcpIpc } from '../../ipc/custom-mcp-ipc'
import { adminManagedContent } from '../../store'
import { createCustomMcpService, type CustomMcpSecrets, type CustomMcpWire } from './custom-mcp-service'
import { readCustomMcpPolicy, type CustomMcpPolicy } from './policy'
import { createCustomMcpRegistry, createFileCustomMcpStore, type CustomMcpStore } from './registry'
import { createHttpsWire } from './wire'

export interface CustomMcpBootstrapDeps {
  ipcMain: Pick<IpcMain, 'handle'>
  assertMainWindow(event: IpcMainInvokeEvent): void
  requireAuth(): boolean
  ownerSession: Pick<OwnerSessionAuthority, 'currentOwnerKey' | 'currentTenantKey' | 'onRevoked'>
  userDataPath(): string
  /** Test seams; production reads admin policy, mcpSecrets and the real https wire. */
  policy?(): CustomMcpPolicy
  secrets?: CustomMcpSecrets
  wire?: CustomMcpWire
  store?: CustomMcpStore
}

/** The per-user managed file can only restrict; an unreadable or absent file means "no restriction from this source". */
async function readUserManaged(userDataPath: () => string): Promise<string | null> {
  try {
    return await readFile(join(userDataPath(), 'managed-config.json'), 'utf8')
  } catch {
    return null
  }
}

/** Main-only custom MCP: scoped registry, policy-gated service on the G60 executor, and the Settings IPC. */
export function bootstrapCustomMcp(deps: CustomMcpBootstrapDeps) {
  const scope = () => {
    const ownerKey = deps.ownerSession.currentOwnerKey()
    const tenantKey = deps.ownerSession.currentTenantKey()
    return ownerKey && tenantKey ? { ownerKey, tenantKey } : null
  }
  let userManaged: string | null = null
  const secrets: CustomMcpSecrets = deps.secrets ?? {
    set: setMcpApiKey,
    get: getMcpApiKey,
    has: hasMcpApiKey
  }
  const registry = createCustomMcpRegistry({
    currentScope: scope,
    store: deps.store ?? createFileCustomMcpStore(deps.userDataPath),
    clearSecret: (id) => void clearMcpApiKey(id)
  })
  const service = createCustomMcpService({
    registry,
    policy: deps.policy ?? (() => readCustomMcpPolicy(adminManagedContent(), userManaged)),
    refreshPolicy: deps.policy
      ? undefined
      : async () => {
          userManaged = await readUserManaged(deps.userDataPath)
        },
    secrets,
    wire: deps.wire ?? createHttpsWire(),
    scope,
    audit: (event, metadata) => auditLog(event as never, metadata as never)
  })
  registerCustomMcpIpc(deps.ipcMain, {
    assertMainWindow: deps.assertMainWindow,
    requireAuth: deps.requireAuth,
    service
  })
  deps.ownerSession.onRevoked((ref, reason) => {
    if (reason !== 'sign-out' && reason !== 'auth-changed') return
    void service.onRevoked({ ownerKey: ref.ownerKey, tenantKey: ref.tenantKey })
  })
  return { registry, service }
}
