import {
  type AccountRef,
  type ConnectorKind,
  type ConnectorProvenance,
  type ConnectorRefusalReason,
  type AccountResolutionRule,
  type ConnectorOperation,
  type ConnectorResult
} from '@shared/connector-catalog'
import { requiresConfirm } from '@shared/connector-effects'
import { recipientFieldsIn } from '@shared/recipient-resolution'
import {
  noTrustedRecipients,
  verifyRecipients,
  type TrustedRecipient,
  type TrustedRecipientSource
} from './recipient-gate'
import type { ConnectorAccountHealthSignal } from '@shared/connector-accounts'
import { ACTION_OBSERVATION_MAX_CHARS, actionDigest, actionIdempotencyKey, isArgsHash } from '../../action-guard'
import type { AccountResolver } from './account-ref'
import { isAccountSelectable, resolveAccount } from './account-resolver'
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
  /** Explicit owner selection (the choice card). It names the account; no other account stands in for it. */
  accountRef?: AccountRef
  /** The account bound to the item the call concerns (G62), supplied by main, never by a renderer or model. */
  sourceAccountRef?: AccountRef
  approval?: ConnectorApproval
}

export interface HandlerContext {
  accountRef: AccountRef
  /** Present on writes: deterministic per approved proposal, for providers that can de-duplicate. */
  idempotencyKey?: string
}

export type HandlerOutcome =
  | { ok: true; output: unknown }
  | {
      ok: false
      error?: string
      needsConsent?: boolean
      healthSignal?: ConnectorAccountHealthSignal
      /** A typed refusal instead of the generic `handler_failed`. */
      refusal?: 'os_permission_missing' | 'effect_uncertain'
      /** Operating-system permission status that caused `os_permission_missing`. */
      permission?: string
    }

export type ConnectorHandler = (input: never, ctx: HandlerContext) => Promise<HandlerOutcome>
export type ConnectorHandlers = Readonly<Record<string, ConnectorHandler>>

/** Typed seam for G31 grants: does the account still hold the scopes this op needs, right now? */
export interface ConnectorGrantSeam {
  check(input: {
    connectorKind: ConnectorKind
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
  accounts: AccountResolver
  /**
   * The accounts the handlers will actually act as right now (built-in Graph handlers use the
   * signed-in session). A call resolved to any other account is refused: a choice never has a different effect than
   * the one shown. Absent means every resolved account is executable (tests, handlers that take `ctx.accountRef`).
   */
  executableAccounts?: (kind: ConnectorKind) => Promise<readonly AccountRef[]>
  writeGate: ConnectorWriteGate
  /** Trusted recipient addresses (G64). Absent means nobody is trusted: a write that names someone is refused. */
  recipients?: TrustedRecipientSource
  /** Metadata only: opId, revision, outcome. Never input or output content. */
  audit?: (event: string, metadata: Record<string, string | number | boolean>) => void
}

export type ConnectorPlan =
  | { ok: true; opId: string; revision: number }
  | { ok: false; reason: 'op_unknown'; message: string }

/** Everything a confirm card needs, resolved by the same path `execute` uses (no second resolver). */
export interface PreparedConnectorCall {
  prepared: true
  /** Verified recipients (empty when the arguments name nobody). */
  recipients: readonly TrustedRecipient[]
  op: ConnectorOperation
  handler: ConnectorHandler
  snapshot: { revision: number }
  accountRef: AccountRef
  accountLabel: string | undefined
  accountHint: string | undefined
  provenance: ConnectorProvenance
  rule: AccountResolutionRule
  parsed: unknown
  argsHash: string
  refuse(
    reason: ConnectorRefusalReason,
    provenance?: ConnectorProvenance,
    extra?: { needsConsent?: boolean; error?: string; permission?: string }
  ): ConnectorResult
}

export interface ConnectorExecutor {
  /** Stamp a call with the revision it is planned against. */
  plan(opId: string, input: unknown): ConnectorPlan
  /** Op, input, account, grant and readiness checks without the write gate or the handler. A refusal is a result. */
  prepare(call: ConnectorCall): Promise<PreparedConnectorCall | ConnectorResult>
  execute(call: ConnectorCall): Promise<ConnectorResult>
}

const MESSAGES: Record<ConnectorRefusalReason, string> = {
  op_unknown: 'That connector operation is not available.',
  catalog_changed: 'The connector catalog changed after this was planned. Plan it again.',
  input_invalid: 'The request does not match what this connector operation accepts.',
  account_unavailable: 'No connected account is available for this operation.',
  account_ambiguous: 'More than one account could do this. Choose which one to use. Nothing was changed.',
  account_not_ready: 'This account is still connecting or needs attention before it can be used.',
  grant_stale: 'The permission for this account is no longer valid. Reconnect it and try again.',
  not_approved: 'This change needs your confirmation first. Nothing was changed.',
  handler_failed: 'The connector could not complete the operation. Nothing was confirmed.',
  output_invalid: 'The connector returned something unexpected, so the result is not trusted.',
  os_permission_missing: 'This Mac has not given Métis permission for that. Nothing was changed.',
  effect_uncertain: 'Métis could not confirm the change was made. Check before trying again. It was not retried.',
  recipient_unverified: 'Métis could not verify who this goes to, so nothing was done.',
  confirm_declined: 'Cancelled. Nothing was changed.'
}

export function createConnectorExecutor(deps: ConnectorExecutorDeps): ConnectorExecutor {
  const audit = (event: string, metadata: Record<string, string | number | boolean>): void => {
    try {
      deps.audit?.(event, metadata)
    } catch {
      /* audit is best effort */
    }
  }

  const self: ConnectorExecutor = {
    plan(opId, _input) {
      const snapshot = deps.catalog.current()
      if (!snapshot.operations.some((op) => op.opId === opId)) {
        return { ok: false, reason: 'op_unknown', message: MESSAGES.op_unknown }
      }
      return { ok: true, opId, revision: snapshot.revision }
    },

    async prepare(call) {
      const snapshot = deps.catalog.current()
      const refuse = (
        reason: ConnectorRefusalReason,
        provenance?: ConnectorProvenance,
        extra: { needsConsent?: boolean; error?: string; permission?: string } = {}
      ): ConnectorResult => {
        audit('connector.refused', {
          opId: call.opId.slice(0, 64),
          reason,
          revision: snapshot.revision,
          plannedRevision: Number.isInteger(call.revision) ? call.revision : -1,
          ...(provenance ? { accountRule: provenance.accountRule } : {})
        })
        return { ok: false, reason, message: MESSAGES[reason], ...(provenance ? { provenance } : {}), ...extra }
      }

      const op = snapshot.operations.find((o) => o.opId === call.opId)
      const handler = op && Object.hasOwn(deps.handlers, op.opId) ? deps.handlers[op.opId] : undefined
      if (!op || !handler) return refuse('op_unknown')
      if (call.revision !== snapshot.revision) return refuse('catalog_changed')

      const parsed = op.input.safeParse(call.input)
      if (!parsed.success) return refuse('input_invalid')

      const candidates = deps.accounts.candidates(op.kind)
      let executable: ReadonlySet<AccountRef> | undefined
      if (deps.executableAccounts) {
        try {
          executable = new Set(await deps.executableAccounts(op.kind))
        } catch {
          executable = new Set()
        }
      }
      const resolution = resolveAccount({
        candidates,
        effect: op.effect,
        ...(executable ? { executable } : {}),
        signals: {
          ...(call.accountRef ? { ownerChoice: call.accountRef } : {}),
          ...(call.sourceAccountRef ? { sourceAccount: call.sourceAccountRef } : {})
        }
      })
      if (!resolution.ok) {
        if (resolution.reason === 'ambiguous') {
          // The operation does not run. Main shows the owner the accounts (renderer-safe fields only) and asks.
          const choices = resolution.options.flatMap((option) => {
            const candidate = candidates.find((c) => c.accountRef === option.accountRef)
            return candidate
              ? [
                  {
                    accountRef: candidate.accountRef,
                    label: candidate.label,
                    ...(candidate.maskedHint ? { maskedHint: candidate.maskedHint } : {}),
                    health: candidate.health,
                    selectable:
                      isAccountSelectable(candidate.health, op.effect) &&
                      (!executable || executable.has(candidate.accountRef)),
                    ...(executable && !executable.has(candidate.accountRef) ? { reason: 'sign_in' as const } : {})
                  }
                ]
              : []
          })
          audit('connector.refused', {
            opId: op.opId,
            reason: 'account_ambiguous',
            revision: snapshot.revision,
            candidateCount: choices.length
          })
          return { ok: false, reason: 'account_ambiguous', message: MESSAGES.account_ambiguous, choices }
        }
        return refuse(resolution.reason === 'not_ready' ? 'account_not_ready' : 'account_unavailable')
      }
      const accountRef = resolution.accountRef
      const provenance: ConnectorProvenance = {
        connectorKind: op.kind,
        accountRef,
        accountRule: resolution.rule,
        opId: op.opId,
        revision: snapshot.revision
      }
      // The signed-in session is what the handler acts as. A different account would silently write elsewhere.
      if (executable && !executable.has(accountRef)) return refuse('account_unavailable', provenance)

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

      // Recipients are verified before any card is shown and again whenever the call is prepared: a send must name
      // someone, and any write that names someone may name only people main trusts (G64).
      let recipients: readonly TrustedRecipient[] = []
      if (requiresConfirm(op.effectClass)) {
        const named = recipientFieldsIn(parsed.data)
        if (named.length > 0 || op.effectClass === 'send') {
          let trusted: readonly TrustedRecipient[] = []
          try {
            trusted = await (deps.recipients ?? noTrustedRecipients).addressesFor({
              accountRef,
              ...(call.sourceAccountRef ? { sourceAccountRef: call.sourceAccountRef } : {})
            })
          } catch {
            trusted = []
          }
          const verified = verifyRecipients(parsed.data, trusted)
          if (!verified.ok || named.length === 0) {
            audit('connector.refused', {
              opId: op.opId,
              reason: 'recipient_unverified',
              effectClass: op.effectClass,
              recipientCount: named.length
            })
            return refuse('recipient_unverified', provenance)
          }
          recipients = verified.recipients
        }
      }

      return {
        prepared: true,
        recipients,
        op,
        handler,
        snapshot,
        accountRef,
        accountLabel: candidates.find((c) => c.accountRef === accountRef)?.label,
        accountHint: candidates.find((c) => c.accountRef === accountRef)?.maskedHint,
        provenance,
        rule: resolution.rule,
        parsed: parsed.data,
        argsHash: writeArgsHash(op.opId, snapshot.revision, parsed.data),
        refuse
      }
    },

    async execute(call) {
      const prepared = await self.prepare(call)
      if (!('prepared' in prepared)) return prepared
      const { op, handler, snapshot, accountRef, provenance, refuse, argsHash } = prepared
      const resolution = { rule: prepared.rule }
      const parsed = { data: prepared.parsed }

      let ctx: HandlerContext = { accountRef }
      let idempotencyKey = ''
      if (requiresConfirm(op.effectClass)) {
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
        if (outcome.refusal === 'os_permission_missing') {
          // An OS permission the owner has not granted says nothing about the account's health.
          return refuse('os_permission_missing', provenance, {
            ...(outcome.permission ? { permission: outcome.permission.slice(0, 32) } : {})
          })
        }
        const healthSignal = outcome.healthSignal ?? (outcome.needsConsent ? 'consent_required' : undefined)
        if (healthSignal) {
          try {
            const recorded = await deps.accounts.observe(op.kind, accountRef, healthSignal)
            if (!recorded) return refuse('account_not_ready', provenance)
          } catch {
            return refuse('account_not_ready', provenance)
          }
        }
        return refuse(outcome.refusal === 'effect_uncertain' ? 'effect_uncertain' : 'handler_failed', provenance, {
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

      audit('connector.executed', {
        opId: op.opId,
        revision: snapshot.revision,
        effect: op.effect,
        accountRule: resolution.rule
      })
      if (!requiresConfirm(op.effectClass)) return { ok: true, output: output.data, provenance }
      const id = (output.data as { id?: unknown }).id
      const observation = `${op.opId} confirmed${typeof id === 'string' ? ` id ${id}` : ''}`.slice(
        0,
        ACTION_OBSERVATION_MAX_CHARS
      )
      return { ok: true, output: output.data, provenance, receipt: { argsHash, idempotencyKey, observation } }
    }
  }
  return self
}
