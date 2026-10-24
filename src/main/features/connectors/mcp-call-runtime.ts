import type { ConnectorEffectClass } from '@shared/connector-effects'
import { requiresConfirm } from '@shared/connector-effects'
import {
  classifyBuiltinMcpTool,
  type McpEffectClassifier,
  type McpEffectInput,
  type McpToolSource
} from '@shared/mcp-effects'
import { actionDigest } from '../../action-guard'
import { isWriteToolName } from '../../mcp/write-tools'
import { pushToMcp, type McpPushResult } from '../../mcp/mcpClient'
import type { ConfirmOutcome, ConnectorConfirmRequest } from './connector-confirm-broker'
import { createActionGuardWriteGate, type ConnectorApproval } from './connector-executor'
import { noTrustedRecipients, verifyRecipients, type TrustedRecipientSource } from './recipient-gate'
import { recipientFieldsIn } from '@shared/recipient-resolution'

export type McpRefusal =
  | 'mcp_source_unavailable'
  | 'read_path_refused_write'
  | 'recipient_unverified'
  | 'confirm_declined'
  | 'no_window'
  | 'confirm_again'

/** A refusal is a failed push the renderer already understands, plus the typed reason. Nothing ran. */
export type McpCallResult = McpPushResult & { refusal?: McpRefusal; effectClass?: ConnectorEffectClass }

const REFUSAL_COPY: Readonly<Record<McpRefusal, string>> = {
  mcp_source_unavailable: 'This connection is not available for actions yet. Nothing was changed.',
  read_path_refused_write: 'That tool changes things, so it cannot run as a lookup. Nothing was changed.',
  recipient_unverified: 'Métis could not verify who this goes to, so nothing was done.',
  confirm_declined: 'Cancelled. Nothing was changed.',
  no_window: 'This needs your confirmation first. Nothing was changed.',
  confirm_again: 'Confirm again in Review. Nothing was changed.'
}

export interface McpTarget {
  source: McpToolSource
  /** `clickup`, `bidstack` or `plane` for the built-in connections; an Operator or custom connection id otherwise. */
  connectionKind: string
  connectionId: string
  /** Shown on the confirm card. */
  label: string
}

/** A saved first-party connection (BidStack, ClickUp, Plane) as a call target. */
export function mcpTargetFor(conn: { id: string; kind: string; label: string }): McpTarget {
  return { source: 'builtin', connectionKind: conn.kind, connectionId: conn.id, label: conn.label }
}

/** The moved `pushToMcp` plus the ClickUp/Plane 401-refresh retry. The refresh retry reuses the same approval. */
export type McpTransport = (
  toolName: string,
  args: Record<string, unknown>,
  idempotencyKey: string | undefined
) => Promise<McpPushResult>

export interface McpCallRuntimeDeps {
  confirm: { issue(request: ConnectorConfirmRequest): Promise<ConfirmOutcome> }
  catalogRevision(): number
  recipients?: TrustedRecipientSource
  audit?(event: string, metadata: Record<string, string | number | boolean>): void
}

export interface McpWriteRequest {
  target: McpTarget
  toolName: string
  args: Record<string, unknown>
  annotations?: McpEffectInput['annotations']
  /** The window that asked. Without one, no card can be shown and nothing runs. */
  ownerWebContentsId?: number
  transport: McpTransport
  /**
   * A retry of an earlier confirmed write: it runs only if the approval's hash matches these exact arguments and the
   * class is a reversible write. Anything else is refused as `confirm_again`.
   */
  retryApproval?: ConnectorApproval
}

export interface McpReadRequest {
  target: McpTarget
  toolName: string
  args: Record<string, unknown>
  annotations?: McpEffectInput['annotations']
  transport: McpTransport
}

export interface McpCallRuntime {
  classify(input: McpEffectInput): ConnectorEffectClass | null
  write(request: McpWriteRequest): Promise<McpCallResult>
  read(request: McpReadRequest): Promise<McpCallResult>
}

/** The plain transport: one `pushToMcp` call. ClickUp/Plane wrap it with their 401 refresh inside the same closure. */
export function pushTransport(
  endpointUrl: string,
  apiKey: string,
  extraHeaders: Record<string, string>,
  label: string
): McpTransport {
  return (toolName, args) => pushToMcp(endpointUrl, apiKey, extraHeaders, toolName, args, label)
}

const customClassifiers: { custom: McpEffectClassifier | null } = { custom: null }

/** The G63 seam: custom MCP connections are classified by whatever G63 registers. With nothing registered they are refused. */
export function registerMcpEffectClassifier(source: 'custom', classifier: McpEffectClassifier | null): void {
  customClassifiers[source] = classifier
}

/** Server hints and name heuristics may only make a class stricter, never lower it. */
function classifyMcpTool(input: McpEffectInput): ConnectorEffectClass | null {
  if (input.source === 'custom') return customClassifiers.custom?.(input) ?? null
  const base = classifyBuiltinMcpTool(input)
  return base === 'read' && isWriteToolName(input.toolName) ? 'irreversible_write' : base
}

/**
 * Every MCP write goes through here (G64): classify, verify recipients against trusted state, hash the exact
 * arguments, wait for the owner's confirm card, check the ActionGuard approval, then call the transport exactly
 * once. Main-initiated reads go through `read`, which refuses any tool not classified `read`.
 */
export function createMcpCallRuntime(deps: McpCallRuntimeDeps): McpCallRuntime {
  const gate = createActionGuardWriteGate()
  const audit = (event: string, metadata: Record<string, string | number | boolean>): void => {
    try {
      deps.audit?.(event, metadata)
    } catch {
      /* audit is best effort */
    }
  }
  const refuse = (
    refusal: McpRefusal,
    target: McpTarget,
    toolName: string,
    effectClass?: ConnectorEffectClass
  ): McpCallResult => {
    // Metadata only: never the arguments, a recipient or a server response.
    audit('mcp.call.refused', {
      source: target.source,
      tool: toolName.slice(0, 64),
      refusal,
      ...(effectClass ? { effectClass } : {})
    })
    return { ok: false, error: REFUSAL_COPY[refusal], refusal, ...(effectClass ? { effectClass } : {}) }
  }
  const input = (target: McpTarget, toolName: string, annotations: McpEffectInput['annotations']): McpEffectInput => ({
    source: target.source,
    connectionKind: target.connectionKind,
    toolName,
    ...(annotations ? { annotations } : {})
  })

  return {
    classify: classifyMcpTool,

    async read(request) {
      const { target, toolName } = request
      const effectClass = classifyMcpTool(input(target, toolName, request.annotations))
      if (effectClass === null) return refuse('mcp_source_unavailable', target, toolName)
      if (effectClass !== 'read') return refuse('read_path_refused_write', target, toolName, effectClass)
      const result = await request.transport(toolName, request.args, undefined)
      audit('mcp.call.read', { source: target.source, tool: toolName.slice(0, 64), ok: result.ok })
      return result
    },

    async write(request) {
      const { target, toolName, args } = request
      const effectClass = classifyMcpTool(input(target, toolName, request.annotations))
      if (effectClass === null) return refuse('mcp_source_unavailable', target, toolName)
      if (!requiresConfirm(effectClass)) {
        const result = await request.transport(toolName, args, undefined)
        audit('mcp.call.read', { source: target.source, tool: toolName.slice(0, 64), ok: result.ok })
        return result
      }

      // Recipients first: a write that names someone runs only for people main trusts, and a send must name someone.
      const named = recipientFieldsIn(args)
      let recipients: readonly { address: string; source: string }[] = []
      if (named.length > 0 || effectClass === 'send') {
        let trusted: Awaited<ReturnType<TrustedRecipientSource['addressesFor']>> = []
        try {
          trusted = await (deps.recipients ?? noTrustedRecipients).addressesFor({})
        } catch {
          trusted = []
        }
        const verified = verifyRecipients(args, trusted)
        if (!verified.ok || named.length === 0) {
          audit('mcp.call.recipient_unverified', {
            source: target.source,
            tool: toolName.slice(0, 64),
            recipientCount: named.length
          })
          return refuse('recipient_unverified', target, toolName, effectClass)
        }
        recipients = verified.recipients
      }

      const argsHash = actionDigest({
        kind: 'mcp-write',
        source: target.source,
        connectionId: target.connectionId,
        toolName,
        args
      })

      let approval: ConnectorApproval
      if (request.retryApproval) {
        // A background retry has no owner at the keyboard: it may only repeat what was confirmed, byte for byte,
        // and only when repeating it is harmless to undo.
        if (effectClass !== 'reversible_write' || !gate.verify(request.retryApproval, argsHash)) {
          return refuse('confirm_again', target, toolName, effectClass)
        }
        approval = request.retryApproval
      } else {
        if (request.ownerWebContentsId === undefined) return refuse('no_window', target, toolName, effectClass)
        const outcome = await deps.confirm.issue({
          ownerWebContentsId: request.ownerWebContentsId,
          opId: `mcp.${target.connectionKind}`.slice(0, 64),
          revision: deps.catalogRevision(),
          argsHash,
          effectClass,
          summary: `Run ${toolName.slice(0, 80)} on ${target.label}`.slice(0, 200),
          connectorLabel: target.label.slice(0, 60),
          ...(recipients.length ? { recipients } : {})
        })
        if (!outcome.confirmed) return refuse('confirm_declined', target, toolName, effectClass)
        approval = outcome.approval
      }

      if (!gate.verify(approval, argsHash)) return refuse('confirm_again', target, toolName, effectClass)
      const result = await request.transport(toolName, args, gate.idempotencyKey(approval))
      audit('mcp.call.write', {
        source: target.source,
        tool: toolName.slice(0, 64),
        effectClass,
        recipientCount: recipients.length,
        ok: result.ok
      })
      return { ...result, effectClass }
    }
  }
}

// Fail closed until the composition root wires the real broker: nothing can be confirmed, so nothing runs.
const unconfigured = createMcpCallRuntime({
  confirm: { issue: async () => ({ confirmed: false, reason: 'revoked' }) },
  catalogRevision: () => 0
})
let active: McpCallRuntime | null = null

/** Wired once by the connector bootstrap; `null` restores the fail-closed default (tests). */
export function configureMcpCallRuntime(runtime: McpCallRuntime | null): void {
  active = runtime
}

/** The one runtime every MCP call site shares. */
export function mcpCallRuntime(): McpCallRuntime {
  return active ?? unconfigured
}
