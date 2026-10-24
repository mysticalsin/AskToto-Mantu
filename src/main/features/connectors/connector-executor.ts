import {
  type AccountRef,
  type ExecutorConnectorKind,
  type ConnectorProvenance,
  type ConnectorRefusalReason,
  type ConnectorResult,
  isWriteEffect
} from '@shared/connector-catalog'
import type { ConnectorAccountHealthSignal } from '@shared/connector-accounts'
import { ACTION_OBSERVATION_MAX_CHARS, actionDigest, actionIdempotencyKey, isArgsHash } from '../../action-guard'
import type { ExecutorAccountResolver } from './account-ref'
import type { CatalogPublisher } from './catalog-publisher'

/** What the owner approved. Main mints it; the arguments are bound by `argsHash`. */
export interface ConnectorApproval {
  proposalId: string
  argsHash: string
}

export interface ConnectorCall {
  opId: string
  /** The catalog revision this call was planned against. */
  revision: number
  input: unknown
  /** Optional explicit owner selection. Omission resolves only when exactly one account is available. */
  accountRef?: AccountRef
  approval?: ConnectorApproval
}

export interface HandlerContext {
  accountRef: AccountRef
  /** Present on writes: deterministic per approved proposal, for providers that can de-duplicate. */
  idempotencyKey?: string
}

export type HandlerOutcome =
  | { ok: true; output: unknown }
  | { ok: false; error?: string; needsConsent?: boolean; healthSignal?: ConnectorAccountHealthSignal }

export type ConnectorHandler = (input: never, ctx: HandlerContext) => Promise<HandlerOutcome>
export type ConnectorHandlers = Readonly<Record<string, ConnectorHandler>>

/** Typed seam for G31 grants: does the account still hold the scopes this op needs, right now? */
export interface ConnectorGrantSeam {
  check(input: {
    connectorKind: ExecutorConnectorKind
    opId: string
    scopes: readonly string[]
    accountRef: AccountRef
  }): Promise<'granted' | 'stale' | 'transient'> | 'granted' | 'stale' | 'transient'
}

export interface ConnectorWriteGate {
  /** True only when the approval is well formed and bound to exactly these arguments. */
  verify(approval: ConnectorApproval | undefined, argsHash: string): approval is ConnectorApproval
  idempotencyKey(approval: ConnectorApproval): string
}

/** The digest an approval must carry for a write: opId, revision and the schema-parsed input. */
export function writeArgsHash(opId: string, revision: number, parsedInput: unknown): string {
  return actionDigest({ kind: 'connector-write', opId, revision, input: parsedInput })
}

/** ActionGuard rules (G04) applied to connector writes: approval binds the exact args; the key is deterministic. */
export function createActionGuardWriteGate(): ConnectorWriteGate {
  return {
    verify(approval, argsHash): approval is ConnectorApproval {
      return (
        !!approval &&
        /^[a-f0-9]{32}$/.test(approval.proposalId) &&
        isArgsHash(approval.argsHash) &&
        approval.argsHash === argsHash
      )
    },
    idempotencyKey: (approval) => actionIdempotencyKey(approval.proposalId, approval.argsHash)
  }
}

export interface ConnectorExecutorDeps {
  catalog: CatalogPublisher
  handlers: ConnectorHandlers
  grants: ConnectorGrantSeam
  accounts: ExecutorAccountResolver
  writeGate: ConnectorWriteGate
  /** Metadata only: opId, revision, outcome. Never input or output content. */
  audit?: (event: string, metadata: Record<string, string | number | boolean>) => void
}

export type ConnectorPlan =
  | { ok: true; opId: string; revision: number }
  | { ok: false; reason: 'op_unknown'; message: string }

export interface ConnectorExecutor {
  /** Stamp a call with the revision it is planned against. */
  plan(opId: string, input: unknown): ConnectorPlan
  execute(call: ConnectorCall): Promise<ConnectorResult>
}

const MESSAGES: Record<ConnectorRefusalReason, string> = {
  op_unknown: 'That connector operation is not available.',
  catalog_changed: 'The connector catalog changed after this was planned. Plan it again.',
  input_invalid: 'The request does not match what this connector operation accepts.',
  account_unavailable: 'No connected account is available for this operation.',
  account_not_ready: 'This account is still connecting or needs attention before it can be used.',
  grant_stale: 'The permission for this account is no longer valid. Reconnect it and try again.',
  not_approved: 'This change needs your confirmation first. Nothing was changed.',
  handler_failed: 'The connector could not complete the operation. Nothing was confirmed.',
  output_invalid: 'The connector returned something unexpected, so the result is not trusted.'
}

export function createConnectorExecutor(deps: ConnectorExecutorDeps): ConnectorExecutor {
  const audit = (event: string, metadata: Record<string, string | number | boolean>): void => {
    try {
      deps.audit?.(event, metadata)
    } catch {
      /* audit is best effort */
    }
  }

  return {
    plan(opId, _input) {
      const snapshot = deps.catalog.current()
      if (!snapshot.operations.some((op) => op.opId === opId)) {
        return { ok: false, reason: 'op_unknown', message: MESSAGES.op_unknown }
      }
      return { ok: true, opId, revision: snapshot.revision }
    },

    async execute(call) {
      const snapshot = deps.catalog.current()
      const refuse = (
        reason: ConnectorRefusalReason,
        provenance?: ConnectorProvenance,
        extra: { needsConsent?: boolean; error?: string } = {}
      ): ConnectorResult => {
        audit('connector.refused', {
          opId: call.opId.slice(0, 64),
          reason,
          revision: snapshot.revision,
          plannedRevision: Number.isInteger(call.revision) ? call.revision : -1
        })
        return { ok: false, reason, message: MESSAGES[reason], ...(provenance ? { provenance } : {}), ...extra }
      }

      const op = snapshot.operations.find((o) => o.opId === call.opId)
      const handler = op && Object.hasOwn(deps.handlers, op.opId) ? deps.handlers[op.opId] : undefined
      if (!op || !handler) return refuse('op_unknown')
      if (call.revision !== snapshot.revision) return refuse('catalog_changed')

      const parsed = op.input.safeParse(call.input)
      if (!parsed.success) return refuse('input_invalid')

      const accountRef = deps.accounts.resolve(op.kind, call.accountRef)
      if (!accountRef) return refuse('account_unavailable')
      const provenance: ConnectorProvenance = {
        connectorKind: op.kind,
        accountRef,
        opId: op.opId,
        revision: snapshot.revision
      }

      let grant: 'granted' | 'stale' | 'transient'
      try {
        grant = await deps.grants.check({ connectorKind: op.kind, opId: op.opId, scopes: op.scopes, accountRef })
      } catch {
        grant = 'transient'
      }
      const grantSignal: ConnectorAccountHealthSignal =
        grant === 'granted'
          ? 'token_refresh_succeeded'
          : grant === 'stale'
            ? 'token_refresh_rejected'
            : 'token_refresh_transient'
      let observed: boolean
      try {
        observed = await deps.accounts.observe(op.kind, accountRef, grantSignal)
      } catch {
        observed = false
      }
      if (!observed) return refuse('account_not_ready', provenance)
      if (!deps.accounts.isReady(op.kind, accountRef, op.effect)) {
        return refuse('account_not_ready', provenance, grant === 'stale' ? { needsConsent: true } : {})
      }

      let ctx: HandlerContext = { accountRef }
      let argsHash = ''
      let idempotencyKey = ''
      if (isWriteEffect(op.effect)) {
        argsHash = writeArgsHash(op.opId, snapshot.revision, parsed.data)
        if (!deps.writeGate.verify(call.approval, argsHash)) return refuse('not_approved', provenance)
        idempotencyKey = deps.writeGate.idempotencyKey(call.approval)
        ctx = { accountRef, idempotencyKey }
      }

      let outcome: HandlerOutcome
      try {
        outcome = await handler(parsed.data as never, ctx)
      } catch {
        // The thrown text may carry provider detail; it is deliberately not forwarded.
        try {
          const recorded = await deps.accounts.observe(op.kind, accountRef, 'transient_failure')
          if (!recorded) return refuse('account_not_ready', provenance)
        } catch {
          return refuse('account_not_ready', provenance)
        }
        return refuse('handler_failed', provenance)
      }
      if (!outcome.ok) {
        const healthSignal = outcome.healthSignal ?? (outcome.needsConsent ? 'consent_required' : undefined)
        if (healthSignal) {
          try {
            const recorded = await deps.accounts.observe(op.kind, accountRef, healthSignal)
            if (!recorded) return refuse('account_not_ready', provenance)
          } catch {
            return refuse('account_not_ready', provenance)
          }
        }
        return refuse('handler_failed', provenance, {
          ...(outcome.needsConsent ? { needsConsent: true } : {}),
          ...(outcome.error ? { error: outcome.error } : {})
        })
      }
      try {
        const recorded = await deps.accounts.observe(op.kind, accountRef, 'operation_succeeded')
        if (!recorded) return refuse('account_not_ready', provenance)
      } catch {
        return refuse('account_not_ready', provenance)
      }
      const output = op.output.safeParse(outcome.output)
      if (!output.success) return refuse('output_invalid', provenance)

      audit('connector.executed', { opId: op.opId, revision: snapshot.revision, effect: op.effect })
      if (!isWriteEffect(op.effect)) return { ok: true, output: output.data, provenance }
      const id = (output.data as { id?: unknown }).id
      const observation = `${op.opId} confirmed${typeof id === 'string' ? ` id ${id}` : ''}`.slice(
        0,
        ACTION_OBSERVATION_MAX_CHARS
      )
      return { ok: true, output: output.data, provenance, receipt: { argsHash, idempotencyKey, observation } }
    }
  }
}
