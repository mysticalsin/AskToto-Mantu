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
import { requiresConfirm } from '@shared/connector-effects'
import type { ConnectorConfirmState } from '@shared/connector-confirm'
import { createCatalogPublisher } from './catalog-publisher'
import { createConnectorConfirmBroker, type ConnectorConfirmBroker } from './connector-confirm-broker'
import {
  createActionGuardWriteGate,
  createConnectorExecutor,
  type ConnectorCall,
  type ConnectorExecutor,
  type ConnectorGrantSeam,
  type PreparedConnectorCall,
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

let confirmDelivery: ((webContentsId: number, state: ConnectorConfirmState) => void) | null = null

/** Wired by the lifecycle composition root: how a confirm card reaches the owner window. Tests pass a recorder. */
export function configureConnectorConfirmDelivery(
  send: ((webContentsId: number, state: ConnectorConfirmState) => void) | null
): void {
  confirmDelivery = send
}

let confirmBroker: ConnectorConfirmBroker | null = null
/** The one connector confirm card broker (G64). Every write waits on it; its proposal id is the ActionGuard approval. */
export function connectorConfirmBroker(): ConnectorConfirmBroker {
  confirmBroker ??= createConnectorConfirmBroker({
    send: (id, state) => confirmDelivery?.(id, state),
    catalogRevision: () => connectorCatalog.current().revision,
    audit: (event, metadata) => auditLog(event as never, metadata as never)
  })
  return confirmBroker
}

const CONNECTOR_LABELS: Readonly<Record<ConnectorKind, string>> = { outlook: 'Outlook' }

/**
 * Show the confirm card for a prepared write and run it only if the owner confirms. The approval the executor sees
 * is the card's own proposal id bound to the hash of the exact arguments. Without a window to show the card in,
 * nothing runs.
 */
async function confirmThenExecute(
  call: ConnectorCall,
  prepared: PreparedConnectorCall,
  ownerWebContentsId: number | undefined
): Promise<ConnectorResult> {
  const exec = connectorExecutor()
  if (!requiresConfirm(prepared.op.effectClass)) return exec.execute(call)
  if (ownerWebContentsId === undefined) return prepared.refuse('not_approved', prepared.provenance)
  const subject = (prepared.parsed as { subject?: unknown } | null)?.subject
  const outcome = await connectorConfirmBroker().issue({
    ownerWebContentsId,
    opId: prepared.op.opId,
    revision: prepared.snapshot.revision,
    argsHash: prepared.argsHash,
    effectClass: prepared.op.effectClass,
    summary: prepared.op.summary,
    connectorLabel: CONNECTOR_LABELS[prepared.op.kind],
    ...(prepared.accountLabel ? { accountLabel: prepared.accountLabel } : {}),
    ...(prepared.accountHint ? { maskedHint: prepared.accountHint } : {}),
    ...(typeof subject === 'string' && subject.trim() ? { subjectPreview: subject.trim().slice(0, 80) } : {}),
    ...(prepared.recipients.length ? { recipients: prepared.recipients } : {})
  })
  if (!outcome.confirmed) return prepared.refuse('confirm_declined', prepared.provenance)
  return exec.execute({ ...call, approval: outcome.approval })
}

async function resumeChosenOperation(
  pending: PendingAccountChoice,
  accountRef: AccountRef
): Promise<AccountChoiceRunResult> {
  // The owner's choice is the only thing that names the account. It does not approve the write: the confirm card
  // does, with its own proposal id bound to the hash of the exact arguments.
  const call: ConnectorCall = { opId: pending.opId, revision: pending.revision, input: pending.input, accountRef }
  const prepared = await connectorExecutor().prepare(call)
  const result =
    'prepared' in prepared ? await confirmThenExecute(call, prepared, pending.ownerWebContentsId) : prepared
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
 * approval is the confirm card's own proposal id, bound to the schema-parsed arguments (G64); the executor still
 * revalidates the revision, the op, the input, the grant and the recipients. The result keeps the legacy `OutlookWriteResult` shape so the renderer is unchanged.
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
  const call: ConnectorCall = {
    opId,
    revision: planned.revision,
    input,
    ...(options.sourceAccountRef ? { sourceAccountRef: options.sourceAccountRef } : {})
  }
  const prepared = await exec.prepare(call)
  if (!('prepared' in prepared)) {
    if (
      prepared.ok === false &&
      prepared.reason === 'account_ambiguous' &&
      prepared.choices &&
      options.ownerWebContentsId !== undefined
    ) {
      accountChoiceBroker().issue({
        ownerWebContentsId: options.ownerWebContentsId,
        opId,
        revision: planned.revision,
        argsHash: writeArgsHash(opId, planned.revision, parsed.data),
        input: parsed.data,
        options: prepared.choices
      })
    }
    return toLegacy(opId, prepared)
  }
  return toLegacy(opId, await confirmThenExecute(call, prepared, options.ownerWebContentsId))
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
