import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { ConnectorOperation, ConnectorRefusalReason } from '@shared/connector-catalog'
import type {
  CustomMcpDraftPayload,
  CustomMcpRefusal,
  CustomMcpResponse,
  CustomMcpToolView,
  CustomMcpView
} from '@shared/custom-mcp'
import { actionDigest } from '../../action-guard'
import { isAddressRefusal } from '../../mcp/mcpClient'
import {
  createActionGuardWriteGate,
  createCatalogPublisher,
  createConnectorExecutor,
  deriveConnectorAccountRef,
  writeArgsHash,
  type ConnectorAccountScope,
  type ConnectorGrantSeam,
  type ConnectorHandlers,
  type ExecutorAccountResolver
} from '../connectors'
import { checkHttpsEndpoint, customAddressGuard } from './endpoint-guard'
import { policyDigest, type CustomMcpPolicy } from './policy'
import type { CustomMcpRegistry, Registration } from './registry'
import { boundedArgsSchema, toolsFingerprint, validateToolList } from './tool-schema'

export interface WireTarget {
  url: string
  headers: Record<string, string>
  guard: (ip: string) => Error | null
}

/** The only code that talks to a custom MCP server. Production: `createHttpsWire`; tests inject a fake. */
export interface CustomMcpWire {
  listTools(target: WireTarget): Promise<unknown[]>
  callTool(
    target: WireTarget,
    name: string,
    args: Record<string, unknown>
  ): Promise<{ isError?: boolean; content?: unknown }>
}

export interface CustomMcpSecrets {
  set(id: string, value: string): void
  get(id: string): string
  has(id: string): boolean
}

export interface CustomMcpServiceDeps {
  registry: CustomMcpRegistry
  policy(): CustomMcpPolicy
  /** Re-reads the policy sources (async file I/O) so the next synchronous `policy()` is fresh. */
  refreshPolicy?(): Promise<void>
  secrets: CustomMcpSecrets
  wire: CustomMcpWire
  scope(): ConnectorAccountScope | null
  /** Metadata only (opId, revision, outcome); never input or output content. */
  audit?(event: string, metadata: Record<string, string | number | boolean>): void
  now?(): number
  /** Owner reading the review card: long enough to read a tool list. */
  reviewTtlMs?: number
  /** Confirm card for one write call. */
  callTtlMs?: number
}

export const CUSTOM_MCP_REVIEW_TTL_MS = 10 * 60_000
const OUTPUT_TEXT_MAX = 64 * 1024
const OUTPUT_PARTS_MAX = 32
const FAILING_AFTER = 3

const OutputSchema = z.object({
  content: z.array(z.object({ type: z.literal('text'), text: z.string().max(OUTPUT_TEXT_MAX) })).max(OUTPUT_PARTS_MAX)
})

const hex = (bytes: number): string => randomBytes(bytes).toString('hex')

export type ProposeCallData =
  | { effect: 'read'; output: unknown }
  | {
      effect: 'create'
      proposalId: string
      summary: { server: string; tool: string; argKeys: string[] }
      expiresAt: number
    }
export interface ConfirmCallData {
  effect: 'create'
  output: unknown
  observation: string
}

interface CallProposal {
  proposalId: string
  scopeKey: string
  registrationId: string
  tool: string
  input: unknown
  revision: number
  expiresAt: number
}

const REFUSAL_FOR: Partial<Record<ConnectorRefusalReason, CustomMcpRefusal>> = {
  catalog_changed: 'catalog_changed',
  input_invalid: 'invalid_input',
  not_approved: 'not_approved',
  grant_stale: 'policy_blocked',
  account_not_ready: 'review_required',
  account_unavailable: 'not_found',
  op_unknown: 'tool_not_allowed'
}

export function createCustomMcpService(deps: CustomMcpServiceDeps) {
  const now = deps.now ?? Date.now
  const reviewTtl = deps.reviewTtlMs ?? CUSTOM_MCP_REVIEW_TTL_MS
  const callTtl = deps.callTtlMs ?? 12_000
  const writeGate = createActionGuardWriteGate()
  const proposals = new Map<string, CallProposal>()
  const failures = new Map<string, number>()

  const fail = (error: CustomMcpRefusal, rule?: string): { ok: false; error: CustomMcpRefusal; rule?: string } =>
    rule ? { ok: false, error, rule } : { ok: false, error }

  /** The first policy rule that no longer admits this registration, or null. Rechecked at boot, list, confirm and call. */
  function admits(reg: Registration, policy: CustomMcpPolicy): string | null {
    if (!policy.allow) return policy.deniedRule ?? 'customMcp.allow'
    // Typed seam only in this build: stdio is refused whatever the policy says (see report, BLOCKED_EXTERNAL).
    if (reg.transport.kind === 'stdio') return 'customMcp.allowStdio'
    const check = checkHttpsEndpoint(reg.transport.url, policy)
    if (!check.ok) return check.rule
    if (reg.tools.length > policy.maxTools) return 'customMcp.maxTools'
    return null
  }

  function headersFor(reg: Registration): Record<string, string> | null {
    if (reg.auth.type === 'none') return {}
    const secret = deps.secrets.has(reg.id) ? deps.secrets.get(reg.id) : ''
    if (!secret) return null
    return reg.auth.type === 'bearer' ? { Authorization: `Bearer ${secret}` } : { [reg.auth.headerName]: secret }
  }

  function targetFor(reg: Registration, policy: CustomMcpPolicy): WireTarget | null {
    if (reg.transport.kind !== 'https') return null
    const headers = headersFor(reg)
    return headers ? { url: reg.transport.url, headers, guard: customAddressGuard(policy) } : null
  }

  /** What the owner's confirm card covers. `allowedTools` is chosen at confirm and bound by the persisted list. */
  const reviewDigest = (reg: Registration, policy: CustomMcpPolicy): string =>
    actionDigest({
      kind: 'custom-mcp-review',
      transport: reg.transport,
      auth: reg.auth,
      toolsFingerprint: reg.toolsFingerprint,
      policyDigest: policyDigest(policy)
    })

  function toView(reg: Registration): CustomMcpView {
    const tools: CustomMcpToolView[] = reg.tools.map((t) => ({
      name: t.name,
      description: t.description,
      effect: t.effect,
      allowed: reg.allowedTools.includes(t.name)
    }))
    const reviewing = reg.state === 'review' || reg.state === 'stale_catalog'
    return {
      id: reg.id,
      label: reg.label,
      transport: reg.transport.kind,
      target: reg.transport.kind === 'https' ? safeHost(reg.transport.url) : 'local process',
      authType: reg.auth.type,
      hasSecret: reg.auth.type === 'none' ? false : deps.secrets.has(reg.id),
      state: reg.state,
      health: reg.health,
      tools,
      ...(reg.lastError ? { lastError: reg.lastError } : {}),
      ...(reg.rule ? { rule: reg.rule } : {}),
      ...(reviewing && reg.reviewToken && reg.reviewToken.expiresAt > now()
        ? { reviewTokenId: reg.reviewToken.id }
        : {})
    }
  }

  /** Move registrations the current policy no longer admits to `policy_blocked`; stale grants need a re-review. */
  async function reconcile(): Promise<Registration[]> {
    await deps.refreshPolicy?.()
    const policy = deps.policy()
    const digest = policyDigest(policy)
    const all = await deps.registry.list()
    const out: Registration[] = []
    for (const reg of all) {
      const rule = reg.state === 'disabled' || reg.state === 'policy_blocked' ? null : admits(reg, policy)
      let next = reg
      if (rule) {
        next =
          (await deps.registry.update(reg.id, (r) => ({
            ...r,
            state: 'policy_blocked',
            rule,
            lastError: 'policy_blocked',
            reviewToken: undefined
          }))) ?? reg
      } else if (reg.state === 'enabled' && reg.policyDigest !== digest) {
        next =
          (await deps.registry.update(reg.id, (r) => ({ ...r, state: 'stale_catalog', reviewToken: undefined }))) ?? reg
      }
      out.push(next)
    }
    return out
  }

  /** Connect, list tools, validate. Returns the registration patch for a successful probe. */
  async function probe(
    reg: Registration
  ): Promise<
    | { ok: true; tools: Registration['tools']; fingerprint: string }
    | { ok: false; error: CustomMcpRefusal; rule?: string }
  > {
    const policy = deps.policy()
    const rule = admits(reg, policy)
    if (rule) return fail('policy_blocked', rule)
    const target = targetFor(reg, policy)
    if (!target) return fail('invalid_input')
    let raw: unknown[]
    try {
      raw = await deps.wire.listTools(target)
    } catch (e) {
      return isAddressRefusal(e) ? fail('endpoint_refused', 'customMcp.allowPrivateNetwork') : fail('probe_failed')
    }
    const validated = validateToolList(raw, { maxTools: policy.maxTools })
    if (!validated.ok) return fail('schema_invalid', validated.rule)
    return { ok: true, tools: validated.tools, fingerprint: toolsFingerprint(validated.tools) }
  }

  const mintToken = (reg: Registration, policy: CustomMcpPolicy): NonNullable<Registration['reviewToken']> => ({
    id: hex(16),
    digest: reviewDigest(reg, policy),
    expiresAt: now() + reviewTtl
  })

  async function probeAndReview(id: string): Promise<CustomMcpResponse<{ server: CustomMcpView }>> {
    await deps.refreshPolicy?.()
    const reg = await deps.registry.get(id)
    if (!reg) return fail('not_found')
    const result = await probe(reg)
    if (!result.ok) {
      const wasLive = reg.state === 'enabled' || reg.state === 'degraded'
      await deps.registry.update(id, (r) => ({
        ...r,
        state: result.error === 'policy_blocked' ? 'policy_blocked' : wasLive ? 'degraded' : 'draft',
        health: wasLive ? 'failing' : r.health,
        lastError: result.error,
        rule: result.rule,
        reviewToken: undefined
      }))
      return fail(result.error, result.rule)
    }
    const policy = deps.policy()
    const unchanged =
      (reg.state === 'enabled' || reg.state === 'degraded') && reg.toolsFingerprint === result.fingerprint
    if (unchanged && reg.policyDigest === policyDigest(policy)) {
      failures.delete(id)
      const updated = await deps.registry.update(id, (r) => ({
        ...r,
        state: 'enabled',
        health: 'healthy',
        lastError: undefined,
        rule: undefined
      }))
      return { ok: true, server: toView(updated ?? reg) }
    }
    const changedWhileLive = reg.state === 'enabled' || reg.state === 'degraded' || reg.state === 'stale_catalog'
    const updated = await deps.registry.update(id, (r) => {
      const next: Registration = {
        ...r,
        tools: result.tools,
        toolsFingerprint: result.fingerprint,
        policyDigest: policyDigest(policy),
        // Nothing the server newly declared (or silently changed) is callable until the owner re-reviews.
        allowedTools: [],
        catalogRevision: r.catalogRevision + 1,
        state: changedWhileLive ? 'stale_catalog' : 'review',
        health: 'unknown',
        lastError: undefined,
        rule: undefined
      }
      return { ...next, reviewToken: mintToken(next, policy) }
    })
    for (const [pid, p] of proposals) if (p.registrationId === id) proposals.delete(pid)
    return updated ? { ok: true, server: toView(updated) } : fail('not_found')
  }

  async function draft(payload: CustomMcpDraftPayload): Promise<CustomMcpResponse<{ server: CustomMcpView }>> {
    if (!deps.registry.scopeKey()) return fail('auth_required')
    await deps.refreshPolicy?.()
    const policy = deps.policy()
    if (payload.transport.kind === 'stdio') return fail('policy_blocked', 'customMcp.allowStdio')
    const check = checkHttpsEndpoint(payload.transport.url, policy)
    if (!check.ok) {
      return fail(
        check.rule === 'customMcp.allow' || check.rule === 'customMcp.invalid' ? 'policy_blocked' : 'endpoint_refused',
        check.rule
      )
    }
    const secret = payload.secret?.trim()
    if (payload.auth.type !== 'none' && !secret) return fail('invalid_input')
    const created = await deps.registry.create({
      label: payload.label,
      transport: payload.transport,
      auth: payload.auth,
      state: 'probing',
      health: 'unknown',
      tools: [],
      allowedTools: [],
      catalogRevision: 0,
      toolsFingerprint: '',
      policyDigest: policyDigest(policy)
    })
    if (!created.ok) return fail(created.error)
    if (payload.auth.type !== 'none' && secret) deps.secrets.set(created.registration.id, secret)
    return probeAndReview(created.registration.id)
  }

  async function confirm(input: {
    id: string
    reviewTokenId: string
    allowedTools: string[]
  }): Promise<CustomMcpResponse<{ server: CustomMcpView }>> {
    await deps.refreshPolicy?.()
    const reg = await deps.registry.get(input.id)
    if (!reg) return fail('not_found')
    if (
      (reg.state !== 'review' && reg.state !== 'stale_catalog') ||
      !reg.reviewToken ||
      reg.reviewToken.id !== input.reviewTokenId
    ) {
      return fail('review_required')
    }
    if (reg.reviewToken.expiresAt <= now()) {
      await deps.registry.update(reg.id, (r) => ({ ...r, reviewToken: undefined }))
      return fail('review_expired')
    }
    const policy = deps.policy()
    const rule = admits(reg, policy)
    if (rule) return fail('policy_blocked', rule)
    if (reg.reviewToken.digest !== reviewDigest(reg, policy)) return fail('review_required')
    const allowed = [...new Set(input.allowedTools)]
    if (allowed.length === 0) return fail('invalid_input')
    const known = new Set(reg.tools.map((t) => t.name))
    if (allowed.length > policy.maxTools || allowed.some((name) => !known.has(name))) return fail('tool_not_allowed')
    const updated = await deps.registry.update(reg.id, (r) => ({
      ...r,
      state: 'enabled',
      health: 'unknown',
      allowedTools: allowed,
      catalogRevision: r.catalogRevision + 1,
      policyDigest: policyDigest(policy),
      reviewToken: undefined,
      lastError: undefined,
      rule: undefined
    }))
    return updated ? { ok: true, server: toView(updated) } : fail('not_found')
  }

  const opIdFor = (id: string, tool: string): string => `cmcp.${id}.${tool}`

  function buildExecutor(reg: Registration, scope: ConnectorAccountScope) {
    const accountRef = deriveConnectorAccountRef(scope, 'custom-mcp', reg.id)
    const operations: ConnectorOperation[] = reg.tools
      .filter((t) => reg.allowedTools.includes(t.name))
      .map((t) => ({
        opId: opIdFor(reg.id, t.name),
        kind: 'custom-mcp',
        effect: t.effect,
        summary: `${reg.label}: ${t.name}`,
        scopes: [],
        input: boundedArgsSchema(t),
        output: OutputSchema
      }))
    const handlers: Record<string, ConnectorHandlers[string]> = {}
    for (const op of operations) {
      const tool = op.opId.slice(opIdFor(reg.id, '').length)
      handlers[op.opId] = async (input: never) => {
        const target = targetFor(reg, deps.policy())
        if (!target) return { ok: false }
        const result = await deps.wire.callTool(target, tool, input as Record<string, unknown>)
        if (result.isError) return { ok: false }
        const parts = Array.isArray(result.content) ? result.content : []
        // Only text is carried across; anything else a server sends is dropped, and size caps are enforced by the output schema.
        const content = parts
          .filter((p): p is { type: 'text'; text: string } => !!p && p.type === 'text' && typeof p.text === 'string')
          .map((p) => ({ type: 'text' as const, text: p.text }))
        return { ok: true, output: { content } }
      }
    }
    const grants: ConnectorGrantSeam = {
      async check({ opId }) {
        const fresh = await deps.registry.get(reg.id)
        const policy = deps.policy()
        const tool = opId.slice(opIdFor(reg.id, '').length)
        const ok =
          !!fresh &&
          fresh.state === 'enabled' &&
          fresh.allowedTools.includes(tool) &&
          admits(fresh, policy) === null &&
          fresh.policyDigest === policyDigest(policy)
        return ok ? 'granted' : 'stale'
      }
    }
    const accounts: ExecutorAccountResolver = {
      resolve: (kind, requested) =>
        kind === 'custom-mcp' && (!requested || requested === accountRef) ? accountRef : null,
      isReady: (kind) => kind === 'custom-mcp' && reg.state === 'enabled' && reg.health !== 'failing',
      async observe(kind, _ref, signal) {
        if (kind !== 'custom-mcp') return false
        // The grant check's own `token_refresh_succeeded` precedes every call, so only a real success resets the count.
        if (signal === 'operation_succeeded') {
          failures.delete(reg.id)
          if (reg.health !== 'healthy') await deps.registry.update(reg.id, (r) => ({ ...r, health: 'healthy' }))
        } else if (signal === 'transient_failure') {
          const count = (failures.get(reg.id) ?? 0) + 1
          failures.set(reg.id, count)
          if (count >= FAILING_AFTER) await deps.registry.update(reg.id, (r) => ({ ...r, health: 'failing' }))
        }
        return true
      }
    }
    const executor = createConnectorExecutor({
      catalog: createCatalogPublisher({ revision: reg.catalogRevision, operations }),
      handlers,
      grants,
      accounts,
      writeGate,
      audit: deps.audit
    })
    return { executor, accountRef, revision: reg.catalogRevision }
  }

  const refusalOf = (reason: ConnectorRefusalReason): CustomMcpRefusal => REFUSAL_FOR[reason] ?? 'call_failed'

  async function prepare(id: string, tool: string) {
    const scope = deps.scope()
    if (!scope || !deps.registry.scopeKey()) return fail('auth_required')
    const reg = (await reconcile()).find((r) => r.id === id)
    if (!reg) return fail('not_found')
    if (reg.state === 'policy_blocked') return fail('policy_blocked', reg.rule)
    if (reg.state !== 'enabled') return fail('review_required')
    if (!reg.allowedTools.includes(tool)) return fail('tool_not_allowed')
    return { ok: true as const, ...buildExecutor(reg, scope), reg }
  }

  /** Reads run now; writes return a main-minted proposal the owner must confirm. The renderer never supplies approval. */
  async function proposeCall(input: {
    id: string
    tool: string
    args: Record<string, unknown>
  }): Promise<CustomMcpResponse<ProposeCallData>> {
    const prepared = await prepare(input.id, input.tool)
    if (!prepared.ok) return prepared
    const opId = opIdFor(input.id, input.tool)
    const planned = prepared.executor.plan(opId, input.args)
    if (!planned.ok) return fail('tool_not_allowed')
    const tool = prepared.reg.tools.find((t) => t.name === input.tool)
    if (!tool) return fail('tool_not_allowed')
    if (tool.effect === 'read') {
      const result = await prepared.executor.execute({
        opId,
        revision: planned.revision,
        input: input.args,
        accountRef: prepared.accountRef
      })
      return result.ok
        ? { ok: true as const, effect: 'read' as const, output: result.output }
        : fail(refusalOf(result.reason))
    }
    const parsed = boundedArgsSchema(tool).safeParse(input.args)
    if (!parsed.success) return fail('invalid_input')
    for (const [pid, p] of proposals) if (p.expiresAt <= now()) proposals.delete(pid)
    const proposal: CallProposal = {
      proposalId: hex(16),
      scopeKey: deps.registry.scopeKey() as string,
      registrationId: input.id,
      tool: input.tool,
      input: parsed.data,
      revision: planned.revision,
      expiresAt: now() + callTtl
    }
    proposals.set(proposal.proposalId, proposal)
    return {
      ok: true as const,
      effect: 'create' as const,
      proposalId: proposal.proposalId,
      summary: { server: prepared.reg.label, tool: input.tool, argKeys: Object.keys(parsed.data as object) },
      expiresAt: proposal.expiresAt
    }
  }

  async function confirmCall(input: { proposalId: string }): Promise<CustomMcpResponse<ConfirmCallData>> {
    const proposal = proposals.get(input.proposalId)
    proposals.delete(input.proposalId)
    if (!proposal || proposal.expiresAt <= now() || proposal.scopeKey !== deps.registry.scopeKey()) {
      return fail('not_approved')
    }
    const prepared = await prepare(proposal.registrationId, proposal.tool)
    if (!prepared.ok) return prepared
    const opId = opIdFor(proposal.registrationId, proposal.tool)
    const result = await prepared.executor.execute({
      opId,
      revision: proposal.revision,
      input: proposal.input,
      accountRef: prepared.accountRef,
      // The hash is recomputed from the stored, schema-parsed input: the renderer has no say in it.
      approval: { proposalId: proposal.proposalId, argsHash: writeArgsHash(opId, proposal.revision, proposal.input) }
    })
    return result.ok
      ? {
          ok: true as const,
          effect: 'create' as const,
          output: result.output,
          observation: result.receipt?.observation ?? ''
        }
      : fail(refusalOf(result.reason))
  }

  return {
    draft,
    confirm,
    refresh: async (id: string): Promise<CustomMcpResponse<{ server: CustomMcpView }>> => {
      if (!deps.registry.scopeKey()) return fail('auth_required')
      return probeAndReview(id)
    },
    list: async (): Promise<CustomMcpResponse<{ servers: CustomMcpView[] }>> => {
      if (!deps.registry.scopeKey()) return fail('auth_required')
      return { ok: true, servers: (await reconcile()).map(toView) }
    },
    disable: async (id: string): Promise<CustomMcpResponse<{ server: CustomMcpView }>> => {
      const updated = await deps.registry.update(id, (r) => ({ ...r, state: 'disabled', reviewToken: undefined }))
      for (const [pid, p] of proposals) if (p.registrationId === id) proposals.delete(pid)
      return updated ? { ok: true, server: toView(updated) } : fail('not_found')
    },
    remove: async (id: string): Promise<CustomMcpResponse> => {
      for (const [pid, p] of proposals) if (p.registrationId === id) proposals.delete(pid)
      return (await deps.registry.remove(id)) ? { ok: true } : fail('not_found')
    },
    proposeCall,
    confirmCall,
    /** Owner signed out: switch the scope's registrations off and drop pending proposals. */
    async onRevoked(scope: ConnectorAccountScope): Promise<void> {
      await deps.registry.disableAll(scope)
      proposals.clear()
    },
    reconcile
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

export type CustomMcpService = ReturnType<typeof createCustomMcpService>
