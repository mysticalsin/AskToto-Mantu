import { randomBytes } from 'node:crypto'
import {
  CONNECTOR_CATALOG,
  CONNECTOR_CATALOG_REVISION,
  type AccountRef,
  type ConnectorKind,
  type ConnectorResult
} from '@shared/connector-catalog'
import { getGraphTokenOutcome } from '../../auth'
import { auditLog } from '../../logger'
import { estimateMcpPushMinutes } from '@shared/time-saved-events'
import { appendTimeSavedEvent } from '../../time-saved-log'
import { OUTLOOK_DRAFT_CONSENT_COPY, OUTLOOK_EVENT_CONSENT_COPY, type OutlookWriteResult } from '../../outlook-write'
import type { AccountResolver } from './account-ref'
import type { ConnectorAccountRegistry } from './account-registry'
import type { AccountChoiceRunResult, AccountChoiceState } from '@shared/connector-account-choice'
import { createAccountChoiceBroker, type AccountChoiceBroker, type PendingAccountChoice } from './account-choice-broker'
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
      const outcome = await getGraphTokenOutcome([...scopes])
      if (outcome.ok) return 'granted'
      return outcome.reason === 'transient' ? 'transient' : 'stale'
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
  candidates: (kind) => accountRuntime?.registry.candidates(kind) ?? [],
  isReady: (kind, ref, effect) => accountRuntime?.registry.isReady(kind, ref, effect) ?? false,
  observe: async (kind, ref, signal) => accountRuntime?.registry.observe(kind, ref, signal) ?? false
}

/** Whether the account is currently usable for a plain read (G60/G61 readiness). The read-only research pipeline asks again at accept time. */
export function connectorReadReady(kind: ConnectorKind, ref: AccountRef): boolean {
  return registeredAccounts.isReady(kind, ref, 'read')
}

let executor: ConnectorExecutor | null = null
export function connectorExecutor(): ConnectorExecutor {
  executor ??= createConnectorExecutor({
    catalog: connectorCatalog,
    handlers: createBuiltinHandlers(),
    grants: graphScopeGrants,
    accounts: registeredAccounts,
    executableAccounts: async (kind) => {
      const ref = await ensureCurrentConnectorAccount(kind)
      return ref ? [ref] : []
    },
    writeGate: createActionGuardWriteGate(),
    audit: (event, metadata) => auditLog(event as never, metadata as never)
  })
  return executor
}

/** The one success side effect of a catalog write, shared by the direct path and a write resumed from the card. */
function recordWriteSuccess(id: string): void {
  try {
    appendTimeSavedEvent({
      kind: 'mcp-push',
      estimatedMinutes: estimateMcpPushMinutes(),
      connector: 'outlook',
      ids: { draft: id }
    })
  } catch {
    /* the time-saved log is best effort */
  }
}

function toLegacy(opId: string, result: ConnectorResult): OutlookWriteResult & { result: ConnectorResult } {
  if (result.ok) {
    const id = (result.output as { id: string }).id
    if (result.receipt) recordWriteSuccess(id)
    return { ok: true, id, result }
  }
  const consent = result.needsConsent ? OUTLOOK_CONSENT_COPY[opId] : undefined
  return {
    ok: false,
    error: consent ?? result.error ?? result.message,
    ...(result.needsConsent ? { needsConsent: true } : {}),
    ...(result.reason === 'effect_uncertain' ? { uncertain: true } : {}),
    result
  }
}

let choiceDelivery: ((webContentsId: number, state: AccountChoiceState) => void) | null = null

/** Wired by the lifecycle composition root: how a card reaches the owner window. Tests pass a recorder. */
export function configureAccountChoiceDelivery(
  send: ((webContentsId: number, state: AccountChoiceState) => void) | null
): void {
  choiceDelivery = send
}

async function resumeChosenOperation(
  pending: PendingAccountChoice,
  accountRef: AccountRef
): Promise<AccountChoiceRunResult> {
  // The owner's choice is the only thing that names the account. The approval is the card's own proposal id and
  // the hash of the exact arguments, so the executor's write gate accepts this operation and nothing else.
  const result = await connectorExecutor().execute({
    opId: pending.opId,
    revision: pending.revision,
    input: pending.input,
    accountRef,
    approval: { proposalId: pending.choiceId, argsHash: pending.argsHash }
  })
  const { result: _result, ...legacy } = toLegacy(pending.opId, result)
  return legacy
}

let choiceBroker: AccountChoiceBroker | null = null
/** The one ambiguity choice card broker (G62). Created on first use; delivery is wired by the composition root. */
export function accountChoiceBroker(): AccountChoiceBroker {
  choiceBroker ??= createAccountChoiceBroker({
    send: (id, state) => choiceDelivery?.(id, state),
    resume: resumeChosenOperation,
    catalogRevision: () => connectorCatalog.current().revision,
    audit: (event, metadata) => auditLog(event as never, metadata as never)
  })
  return choiceBroker
}

export interface ConnectorWriteOptions {
  /** The window that asked. With more than one eligible account, the choice card is issued to it. */
  ownerWebContentsId?: number
  /** The account bound to the item being written about (main-supplied; never from a renderer). */
  sourceAccountRef?: AccountRef
}

/**
 * Run a catalog write for an owner who just asked for it through a main-window-gated IPC (the Review button). The
 * approval is minted here, bound to the schema-parsed arguments, and the executor still revalidates the revision,
 * the op, the input and the grant. ASSUMED until G64 routes the confirm card's own proposal id through here.
 * The result keeps the legacy `OutlookWriteResult` shape so the renderer is unchanged.
 *
 * When more than one account could run it and no trusted signal picks one, nothing runs: a choice card is issued to
 * `ownerWebContentsId`, and the owner's choice resumes exactly this operation once (account-choice-broker.ts).
 */
export async function runConnectorWriteDetailed(
  opId: string,
  input: unknown,
  options: ConnectorWriteOptions = {}
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
  const argsHash = writeArgsHash(opId, planned.revision, parsed.data)
  const result = await exec.execute({
    opId,
    revision: planned.revision,
    input,
    ...(options.sourceAccountRef ? { sourceAccountRef: options.sourceAccountRef } : {}),
    approval: { proposalId: randomBytes(16).toString('hex'), argsHash }
  })
  if (
    !result.ok &&
    result.reason === 'account_ambiguous' &&
    result.choices &&
    options.ownerWebContentsId !== undefined
  ) {
    accountChoiceBroker().issue({
      ownerWebContentsId: options.ownerWebContentsId,
      opId,
      revision: planned.revision,
      argsHash,
      input: parsed.data,
      options: result.choices
    })
  }
  return toLegacy(opId, result)
}

export async function runConnectorWrite(
  opId: string,
  input: unknown,
  options?: ConnectorWriteOptions
): Promise<OutlookWriteResult> {
  const { result: _result, ...legacy } = await runConnectorWriteDetailed(opId, input, options)
  return legacy
}

export { outlookWriteStatus } from '../../outlook-write'
