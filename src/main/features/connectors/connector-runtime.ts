import { randomBytes } from 'node:crypto'
import { CONNECTOR_CATALOG, CONNECTOR_CATALOG_REVISION, type AccountRef, type ConnectorKind, type ConnectorResult } from '@shared/connector-catalog'
import { getGraphToken } from '../../auth'
import { auditLog } from '../../logger'
import { OUTLOOK_DRAFT_CONSENT_COPY, OUTLOOK_EVENT_CONSENT_COPY, type OutlookWriteResult } from '../../outlook-write'
import type { AccountResolver } from './account-ref'
import type { ConnectorAccountRegistry } from './account-registry'
import { createCatalogPublisher } from './catalog-publisher'
import {
  createActionGuardWriteGate,
  createConnectorExecutor,
  type ConnectorExecutor,
  type ConnectorGrantSeam,
  writeArgsHash
} from './connector-executor'
import { createBuiltinHandlers } from './connector-handlers'

/** Shown when a write's grant is no longer valid. Same honest wording the Graph path has always used. */
export const OUTLOOK_CONSENT_COPY: Readonly<Record<string, string>> = {
  'outlook.draft.create': OUTLOOK_DRAFT_CONSENT_COPY,
  'outlook.event.create': OUTLOOK_EVENT_CONSENT_COPY
}

/** G31 seam, Outlook flavour: the grant is valid exactly while a Graph token for every required scope can be acquired. */
export const graphScopeGrants: ConnectorGrantSeam = {
  async check({ scopes }) {
    try {
      return (await getGraphToken([...scopes])) ? 'granted' : 'stale'
    } catch {
      return 'transient'
    }
  }
}

/** Main-owned catalog publication point. Consumers read the current revision at execution time. */
export const connectorCatalog = createCatalogPublisher({
  revision: CONNECTOR_CATALOG_REVISION,
  operations: CONNECTOR_CATALOG
})

export interface ConnectorAccountRuntime {
  registry: ConnectorAccountRegistry
  ensureCurrentAccount(kind: ConnectorKind): Promise<AccountRef | null>
}

let accountRuntime: ConnectorAccountRuntime | null = null

/** Wired once by the lifecycle composition root. Tests use an in-memory registry through this same seam. */
export function configureConnectorAccountRuntime(runtime: ConnectorAccountRuntime | null): void {
  accountRuntime = runtime
}

export async function ensureCurrentConnectorAccount(kind: ConnectorKind): Promise<AccountRef | null> {
  if (!accountRuntime) return null
  await accountRuntime.registry.prepareCurrentScope()
  return accountRuntime.ensureCurrentAccount(kind)
}

const registeredAccounts: AccountResolver = {
  resolve: (kind, requested) => accountRuntime?.registry.resolve(kind, requested) ?? null,
  isReady: (kind, ref, effect) => accountRuntime?.registry.isReady(kind, ref, effect) ?? false,
  observe: async (kind, ref, signal) => accountRuntime?.registry.observe(kind, ref, signal) ?? false
}

let executor: ConnectorExecutor | null = null
export function connectorExecutor(): ConnectorExecutor {
  executor ??= createConnectorExecutor({
    catalog: connectorCatalog,
    handlers: createBuiltinHandlers(),
    grants: graphScopeGrants,
    accounts: registeredAccounts,
    writeGate: createActionGuardWriteGate(),
    audit: (event, metadata) => auditLog(event as never, metadata as never)
  })
  return executor
}

/**
 * Run a catalog write for an owner who just asked for it through a main-window-gated IPC (the Review button). The
 * approval is minted here, bound to the schema-parsed arguments, and the executor still revalidates the revision,
 * the op, the input and the grant. ASSUMED until G64 routes the confirm card's own proposal id through here.
 * The result keeps the legacy `OutlookWriteResult` shape so the renderer is unchanged.
 */
export async function runConnectorWriteDetailed(
  opId: string,
  input: unknown
): Promise<OutlookWriteResult & { result: ConnectorResult }> {
  const exec = connectorExecutor()
  const planned = exec.plan(opId, input)
  const op = CONNECTOR_CATALOG.find((o) => o.opId === opId)
  const parsed = op?.input.safeParse(input)
  if (!planned.ok || !op || !parsed?.success) {
    const result = await exec.execute({ opId, revision: connectorCatalog.current().revision, input })
    return { ok: false, error: result.ok ? undefined : result.message, result }
  }
  let accountRef: AccountRef | null = null
  try {
    accountRef = await ensureCurrentConnectorAccount(op.kind)
  } catch {
    accountRef = null
  }
  if (!accountRef) {
    const result: ConnectorResult = {
      ok: false,
      reason: 'account_unavailable',
      message: 'No connected account is available for this operation.'
    }
    return { ok: false, error: result.message, result }
  }
  const result = await exec.execute({
    opId,
    revision: planned.revision,
    input,
    approval: {
      proposalId: randomBytes(16).toString('hex'),
      argsHash: writeArgsHash(opId, planned.revision, parsed.data)
    }
  })
  if (result.ok) return { ok: true, id: (result.output as { id: string }).id, result }
  const consent = result.needsConsent ? OUTLOOK_CONSENT_COPY[opId] : undefined
  return {
    ok: false,
    error: consent ?? result.error ?? result.message,
    ...(result.needsConsent ? { needsConsent: true } : {}),
    result
  }
}

export async function runConnectorWrite(opId: string, input: unknown): Promise<OutlookWriteResult> {
  const { result: _result, ...legacy } = await runConnectorWriteDetailed(opId, input)
  return legacy
}

export { outlookWriteStatus } from '../../outlook-write'
