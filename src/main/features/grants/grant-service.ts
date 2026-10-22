/**
 * The grant service (G31): composes the three separate decisions around one action.
 *
 *   allowance   did the user say yes to this kind of action, in this scope?   (ActionGrantStore)
 *   purchase    is there plan or quota for it?                                (PurchaseSeam, G79/G80)
 *   permission  has the OS allowed Métis to do it?                            (OsPermissionSeam, G10 probes)
 *
 * Each can refuse on its own, each has its own refusal copy (grant-copy.ts) and its own audit record, and none can
 * stand in for another: a purchase never mints a grant, an approval never creates an OS permission, and an OS
 * permission is never an approval. Only reversible and create actions may ever skip the confirm card; send, type
 * and delete always confirm. A wake word never runs an action even with a grant.
 *
 * Purchase is a typed seam with no fake meter: with nothing bound the honest verdict is 'not_metered', which does
 * not block (there is no desktop-action meter today). A meter that is bound but cannot be read fails closed.
 */
import type { DesktopActionRequest, DesktopAdapterId } from '@shared/desktop-actions'
import { classifyDesktopRequest, voicePlatformOf, type VoiceActionClass } from '@shared/voice/catalog'
import type { VoiceTurnSource } from '@shared/voice/voice-action-policy'
import { actionArgsHash } from '../../action-guard'
import {
  DECISION_OF_REASON,
  permissionDeniedCopy,
  refusalFor,
  type GrantRefusal,
  type GrantRefusalReason
} from './grant-copy'
import {
  isGrantableAction,
  type ActionGrant,
  type GrantAudit,
  type GrantOwner,
  type GrantRevokeReason,
  type GrantScopeContext,
  type GrantScopeKind,
  type GrantSummary
} from './grant-model'
import { ActionGrantStore, type GrantIssueResult, type GrantStoreDeps } from './grant-store'
import type { OsPermissionSeam } from './os-permission-seam'

export type { OsPermissionSeam, OsPermissionVerdict } from './os-permission-seam'

/** `available`: a meter was read and there is room. `not_metered`: nothing is bound, so nothing is enforced. */
export type PurchaseVerdict = 'available' | 'not_metered' | 'exhausted' | 'unavailable'

/** Typed seam for the metering tickets (G79/G80). Nothing in this module invents a meter. */
export interface PurchaseSeam {
  check(input: { actionId: DesktopAdapterId }): Promise<PurchaseVerdict> | PurchaseVerdict
}

export const NOT_METERED: PurchaseSeam = { check: async () => 'not_metered' as const }

/** Only a trusted hardware hold or a click may use a standing grant. */
const GRANT_SKIP_SOURCES: ReadonlySet<VoiceTurnSource> = new Set(['push-to-talk', 'panel'])

export type GrantedRunDecision =
  | { outcome: 'run'; grant: ActionGrant }
  /** Show the confirm card. `refusal` says which decision sent it there. */
  | { outcome: 'confirm'; refusal: GrantRefusal }
  /** Nothing runs and there is nothing to approve. */
  | { outcome: 'refuse'; refusal: GrantRefusal }

export interface ActionGrantServiceDeps extends Pick<GrantStoreDeps, 'now' | 'newId' | 'ttlMs'> {
  platform?: NodeJS.Platform | string
  audit?: GrantAudit
  /** The sign-in generation, so a grant cannot outlive the session that gave it. */
  authGeneration?: () => number
  /** Main-owned scope ids. Absent until G28 (conversation) and G32/G33 (task) supply them. */
  context?: () => GrantScopeContext
  purchase?: PurchaseSeam
  permission?: OsPermissionSeam
}

/** The lifecycle events CommandControl already announces that also end a standing grant. Blur and hide do not. */
const LIFECYCLE_REVOKES: Readonly<Record<string, GrantRevokeReason>> = {
  auth_session_cleared: 'sign_out',
  window_replaced: 'owner_switch',
  window_closed: 'owner_switch',
  renderer_replaced: 'owner_switch',
  system_suspend: 'lock_or_suspend',
  screen_locked: 'lock_or_suspend'
}

/** Input-session hard stops that end a grant. A routine turn end, hide or device change does not. */
const HARD_STOP_REVOKES: Readonly<Record<string, GrantRevokeReason>> = {
  'user-stop': 'stop',
  shutdown: 'stop',
  'sign-out': 'sign_out',
  'auth-revoked': 'sign_out',
  'owner-replaced': 'owner_switch',
  'renderer-reset': 'owner_switch',
  'system-suspend': 'lock_or_suspend',
  'screen-locked': 'lock_or_suspend'
}

export function grantRevokeReasonForLifecycle(reason: string): GrantRevokeReason | null {
  return Object.hasOwn(LIFECYCLE_REVOKES, reason) ? (LIFECYCLE_REVOKES[reason] ?? null) : null
}

export function grantRevokeReasonForHardStop(reason: string): GrantRevokeReason | null {
  return Object.hasOwn(HARD_STOP_REVOKES, reason) ? (HARD_STOP_REVOKES[reason] ?? null) : null
}

export interface ActionGrantService {
  /** The owner binding main derives from the IPC sender and the live sign-in generation. */
  ownerFor(webContentsId: number): GrantOwner
  /** Record the user's approval as a grant of the requested scope. Never throws. */
  issueFromApproval(owner: GrantOwner, request: DesktopActionRequest, scope: GrantScopeKind): GrantIssueResult
  /** Allowance, then purchase, then permission, for a request whose class is derived from the platform. */
  decide(owner: GrantOwner, request: DesktopActionRequest, source: VoiceTurnSource): Promise<GrantedRunDecision>
  decideForClass(
    owner: GrantOwner,
    request: DesktopActionRequest,
    actionClass: VoiceActionClass | null,
    source: VoiceTurnSource
  ): Promise<GrantedRunDecision>
  /** Purchase and permission only, for an action the user already approved on the card. Null means go ahead. */
  checkEffects(request: DesktopActionRequest): Promise<GrantRefusal | null>
  /** Take the grant for one dispatch (an action grant is spent). */
  use(grantId: string): boolean
  list(): GrantSummary[]
  revokeGrant(grantId: string): boolean
  endTask(taskLineageId: string): number
  endConversation(conversationId: string): number
  onLifecycleEvent(reason: string): void
  onHardStop(reason: string): void
}

export function createActionGrantService(deps: ActionGrantServiceDeps = {}): ActionGrantService {
  const platform = voicePlatformOf(deps.platform ?? process.platform)
  const audit: GrantAudit = (event, metadata) => {
    try {
      deps.audit?.(event, metadata)
    } catch {
      /* audit is best effort */
    }
  }
  const store = new ActionGrantStore({ now: deps.now, newId: deps.newId, ttlMs: deps.ttlMs, audit })
  const purchaseSeam = deps.purchase ?? NOT_METERED
  const context = (): GrantScopeContext => {
    try {
      return deps.context?.() ?? {}
    } catch {
      return {}
    }
  }
  const classify = (request: DesktopActionRequest): VoiceActionClass | null => classifyDesktopRequest(request, platform)

  async function purchaseRefusal(request: DesktopActionRequest): Promise<GrantRefusal | null> {
    let verdict: PurchaseVerdict
    try {
      verdict = await purchaseSeam.check({ actionId: request.id })
    } catch {
      verdict = 'unavailable'
    }
    const refusal: GrantRefusal | null =
      verdict === 'exhausted'
        ? refusalFor('quota_exhausted')
        : verdict === 'available' || verdict === 'not_metered'
          ? null
          : refusalFor('quota_unavailable')
    audit('grant.decision', {
      decision: 'purchase',
      outcome: refusal ? 'refused' : verdict === 'not_metered' ? 'not_metered' : 'allowed',
      ...(refusal ? { reason: refusal.reason } : {}),
      actionId: request.id
    })
    return refusal
  }

  /** `unknown` is returned separately because the two callers treat it differently. */
  async function permissionVerdict(
    request: DesktopActionRequest
  ): Promise<{ refusal: GrantRefusal | null; unknown: boolean; permission?: string }> {
    if (!deps.permission) return { refusal: null, unknown: true }
    let verdict: Awaited<ReturnType<OsPermissionSeam['check']>>
    try {
      verdict = await deps.permission.check(request)
    } catch {
      verdict = { status: 'unknown', permission: 'automation' }
    }
    if (verdict.status === 'denied') {
      return {
        refusal: refusalFor('permission_denied', permissionDeniedCopy(verdict.target)),
        unknown: false,
        permission: verdict.permission
      }
    }
    if (verdict.status === 'unknown') return { refusal: null, unknown: true, permission: verdict.permission }
    return { refusal: null, unknown: false }
  }

  const auditPermission = (request: DesktopActionRequest, outcome: string, permission?: string): void =>
    audit('grant.decision', {
      decision: 'permission',
      outcome,
      actionId: request.id,
      ...(permission ? { permission } : {})
    })

  async function decideForClass(
    owner: GrantOwner,
    request: DesktopActionRequest,
    actionClass: VoiceActionClass | null,
    source: VoiceTurnSource
  ): Promise<GrantedRunDecision> {
    const meta = { actionId: request.id, class: actionClass ?? 'none' }
    const confirm = (reason: GrantRefusalReason): GrantedRunDecision => {
      audit('grant.decision', { decision: DECISION_OF_REASON[reason], outcome: 'confirm', reason, ...meta })
      return { outcome: 'confirm', refusal: refusalFor(reason) }
    }
    if (!isGrantableAction(request, actionClass)) return confirm('not_grantable')
    if (!GRANT_SKIP_SOURCES.has(source)) return confirm('source_not_trusted')
    const found = store.find({
      request,
      argsHash: actionArgsHash(request),
      actionClass,
      owner,
      context: context()
    })
    if (found.kind === 'none') return confirm(found.reason)
    audit('grant.decision', { decision: 'allowance', outcome: 'allowed', scope: found.grant.binding.kind, ...meta })

    const purchase = await purchaseRefusal(request)
    if (purchase) return { outcome: 'refuse', refusal: purchase }

    const permission = await permissionVerdict(request)
    if (permission.refusal) {
      auditPermission(request, 'refused', permission.permission)
      return { outcome: 'refuse', refusal: permission.refusal }
    }
    if (permission.unknown) {
      auditPermission(request, 'unverified', permission.permission)
      audit('grant.decision', { decision: 'permission', outcome: 'confirm', reason: 'permission_unverified', ...meta })
      return { outcome: 'confirm', refusal: refusalFor('permission_unverified') }
    }
    auditPermission(request, 'allowed')
    return { outcome: 'run', grant: found.grant }
  }

  return {
    ownerFor: (webContentsId) => ({ webContentsId, authGeneration: deps.authGeneration?.() ?? 0 }),
    issueFromApproval(owner, request, scope) {
      try {
        return store.issue({
          scope,
          request,
          argsHash: actionArgsHash(request),
          actionClass: classify(request),
          owner,
          context: context()
        })
      } catch {
        return { ok: false, reason: 'scope_unavailable' }
      }
    },
    decide: (owner, request, source) => decideForClass(owner, request, classify(request), source),
    decideForClass,
    async checkEffects(request) {
      const purchase = await purchaseRefusal(request)
      if (purchase) return purchase
      // The user already approved, so an unreadable permission does not block: the adapter reads it again itself.
      const permission = await permissionVerdict(request)
      if (permission.refusal) {
        auditPermission(request, 'refused', permission.permission)
        return permission.refusal
      }
      return null
    },
    use: (grantId) => store.use(grantId),
    list: () => store.list(),
    revokeGrant: (grantId) => store.revokeGrant(grantId),
    endTask: (taskLineageId) => store.revokeTask(taskLineageId),
    endConversation: (conversationId) => store.revokeConversation(conversationId),
    onLifecycleEvent(reason) {
      const revoke = grantRevokeReasonForLifecycle(reason)
      if (revoke) store.revokeAll(revoke)
    },
    onHardStop(reason) {
      const revoke = grantRevokeReasonForHardStop(reason)
      if (revoke) store.revokeAll(revoke)
    }
  }
}
