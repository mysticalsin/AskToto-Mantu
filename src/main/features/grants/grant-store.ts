/**
 * In-memory store of live grants (G31). Grants are deliberately not persisted: a restart, a sign-out or a window
 * swap ends every standing approval, so nothing outlives the session that gave it. Pure of Electron and fs.
 *
 * A grant matches only when its action id, class, owner and scope all agree with the request being decided.
 * Expired grants are dropped as they are met and audited once. Every removal names its reason.
 */
import { randomBytes } from 'node:crypto'
import type { DesktopActionRequest } from '@shared/desktop-actions'
import type { VoiceActionClass } from '@shared/voice/catalog'
import {
  DEFAULT_GRANT_TTL_MS,
  GRANT_LIMIT,
  GRANT_SCOPE_ID_MAX_CHARS,
  grantSummary,
  isGrantableAction,
  MAX_GRANT_TTL_MS,
  type ActionGrant,
  type GrantAudit,
  type GrantBinding,
  type GrantOwner,
  type GrantRevokeReason,
  type GrantScopeContext,
  type GrantScopeKind,
  type GrantSummary
} from './grant-model'

export interface GrantStoreDeps {
  now?: () => number
  newId?: () => string
  ttlMs?: Partial<Record<GrantScopeKind, number>>
  audit?: GrantAudit
}

export interface GrantIssueInput {
  scope: GrantScopeKind
  request: DesktopActionRequest
  argsHash: string
  /** The class main derived for this platform. Null means the platform cannot run the action. */
  actionClass: VoiceActionClass | null
  owner: GrantOwner
  context: GrantScopeContext
}

export type GrantIssueResult =
  | { ok: true; grant: ActionGrant }
  | { ok: false; reason: 'not_grantable' | 'scope_unavailable' | 'limit' }

export interface GrantFindInput {
  request: DesktopActionRequest
  argsHash: string
  actionClass: VoiceActionClass | null
  owner: GrantOwner
  context: GrantScopeContext
}

export type GrantFindResult =
  | { kind: 'match'; grant: ActionGrant }
  | { kind: 'none'; reason: 'no_grant' | 'not_grantable' | 'grant_expired' }

function validScopeId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= GRANT_SCOPE_ID_MAX_CHARS
}

export class ActionGrantStore {
  private readonly grants = new Map<string, ActionGrant>()
  private readonly now: () => number
  private readonly newId: () => string
  private readonly ttl: Readonly<Record<GrantScopeKind, number>>

  constructor(private readonly deps: GrantStoreDeps = {}) {
    this.now = deps.now ?? Date.now
    this.newId = deps.newId ?? (() => randomBytes(16).toString('hex'))
    const ttl = { ...DEFAULT_GRANT_TTL_MS, ...deps.ttlMs }
    this.ttl = {
      action: Math.min(MAX_GRANT_TTL_MS, Math.max(1, ttl.action)),
      task: Math.min(MAX_GRANT_TTL_MS, Math.max(1, ttl.task)),
      conversation: Math.min(MAX_GRANT_TTL_MS, Math.max(1, ttl.conversation))
    }
  }

  issue(input: GrantIssueInput): GrantIssueResult {
    const refuse = (reason: 'not_grantable' | 'scope_unavailable' | 'limit'): GrantIssueResult => {
      this.deps.audit?.('grant.decision', {
        decision: 'allowance',
        outcome: 'refused',
        reason,
        actionId: input.request.id,
        scope: input.scope
      })
      return { ok: false, reason }
    }
    if (!isGrantableAction(input.request, input.actionClass)) return refuse('not_grantable')
    const actionClass = input.actionClass as ActionGrant['actionClass']
    let binding: GrantBinding
    if (input.scope === 'action') {
      binding = { kind: 'action', argsHash: input.argsHash }
    } else if (input.scope === 'task') {
      if (!validScopeId(input.context.taskLineageId)) return refuse('scope_unavailable')
      binding = { kind: 'task', taskLineageId: input.context.taskLineageId }
    } else {
      if (!validScopeId(input.context.conversationId)) return refuse('scope_unavailable')
      binding = { kind: 'conversation', conversationId: input.context.conversationId }
    }
    this.pruneExpired()
    // The same approval again refreshes one grant: it never stacks, so a single revoke ends the scope.
    for (const [id, existing] of this.grants) {
      if (
        existing.actionId === input.request.id &&
        existing.owner.webContentsId === input.owner.webContentsId &&
        sameBinding(existing.binding, binding)
      ) {
        this.grants.delete(id)
      }
    }
    if (this.grants.size >= GRANT_LIMIT) return refuse('limit')
    const issuedAt = this.now()
    const grant: ActionGrant = Object.freeze({
      grantId: this.newId(),
      binding: Object.freeze(binding),
      actionId: input.request.id,
      actionClass,
      owner: Object.freeze({ ...input.owner }),
      issuedAt,
      expiresAt: issuedAt + this.ttl[input.scope]
    })
    this.grants.set(grant.grantId, grant)
    this.deps.audit?.('grant.issued', { scope: input.scope, actionId: grant.actionId, class: actionClass })
    return { ok: true, grant }
  }

  /** Read-only apart from dropping grants that expired or belong to a different owner. */
  find(input: GrantFindInput): GrantFindResult {
    this.dropForeignOwners(input.owner)
    const expired = this.pruneExpired(input.request.id)
    if (!isGrantableAction(input.request, input.actionClass)) return { kind: 'none', reason: 'not_grantable' }
    for (const grant of this.grants.values()) {
      if (grant.actionId !== input.request.id || grant.actionClass !== input.actionClass) continue
      if (grant.binding.kind === 'action' && grant.binding.argsHash === input.argsHash) return { kind: 'match', grant }
      if (grant.binding.kind === 'task' && grant.binding.taskLineageId === input.context.taskLineageId) {
        return { kind: 'match', grant }
      }
      if (grant.binding.kind === 'conversation' && grant.binding.conversationId === input.context.conversationId) {
        return { kind: 'match', grant }
      }
    }
    return { kind: 'none', reason: expired ? 'grant_expired' : 'no_grant' }
  }

  /**
   * Take the grant for one dispatch. An action grant is spent; a task or conversation grant stays. False when the
   * grant is gone or expired, so a caller that raced a revocation does not dispatch.
   */
  use(grantId: string): boolean {
    const grant = this.grants.get(grantId)
    if (!grant) return false
    if (this.now() >= grant.expiresAt) {
      this.remove(grant, 'expired')
      return false
    }
    if (grant.binding.kind === 'action') this.grants.delete(grantId)
    return true
  }

  revokeGrant(grantId: string): boolean {
    const grant = this.grants.get(grantId)
    if (!grant) return false
    this.remove(grant, 'user_revoked')
    return true
  }

  revokeAll(reason: GrantRevokeReason): number {
    return this.revokeWhere(reason, () => true)
  }

  revokeTask(taskLineageId: string): number {
    return this.revokeWhere(
      'task_end',
      (grant) => grant.binding.kind === 'task' && grant.binding.taskLineageId === taskLineageId
    )
  }

  revokeConversation(conversationId: string): number {
    return this.revokeWhere(
      'conversation_end',
      (grant) => grant.binding.kind === 'conversation' && grant.binding.conversationId === conversationId
    )
  }

  list(): GrantSummary[] {
    this.pruneExpired()
    return [...this.grants.values()].map(grantSummary)
  }

  private revokeWhere(reason: GrantRevokeReason, predicate: (grant: ActionGrant) => boolean): number {
    let count = 0
    for (const grant of [...this.grants.values()]) {
      if (!predicate(grant)) continue
      this.remove(grant, reason)
      count += 1
    }
    return count
  }

  /** A grant approved under another window or an older sign-in is not this owner's. It ends, it is not borrowed. */
  private dropForeignOwners(owner: GrantOwner): void {
    for (const grant of [...this.grants.values()]) {
      if (grant.owner.webContentsId !== owner.webContentsId) this.remove(grant, 'owner_switch')
      else if (grant.owner.authGeneration !== owner.authGeneration) this.remove(grant, 'sign_out')
    }
  }

  /** Drops expired grants. True when one for `actionId` (any, when omitted) was dropped. */
  private pruneExpired(actionId?: string): boolean {
    let dropped = false
    const now = this.now()
    for (const grant of [...this.grants.values()]) {
      if (now < grant.expiresAt) continue
      this.remove(grant, 'expired')
      if (actionId === undefined || grant.actionId === actionId) dropped = true
    }
    return dropped
  }

  private remove(grant: ActionGrant, reason: GrantRevokeReason): void {
    this.grants.delete(grant.grantId)
    this.deps.audit?.('grant.revoked', {
      reason,
      scope: grant.binding.kind,
      actionId: grant.actionId,
      class: grant.actionClass
    })
  }
}

function sameBinding(a: GrantBinding, b: GrantBinding): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'action' && b.kind === 'action') return a.argsHash === b.argsHash
  if (a.kind === 'task' && b.kind === 'task') return a.taskLineageId === b.taskLineageId
  if (a.kind === 'conversation' && b.kind === 'conversation') return a.conversationId === b.conversationId
  return false
}
