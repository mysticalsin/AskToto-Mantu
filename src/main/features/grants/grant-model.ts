/**
 * Typed grant model (G31): what a user approval can cover, for how long, and what ends it.
 *
 * A grant records one allowance decision: "the user said yes to this kind of action, in this scope". It is not
 * a purchase and not an operating-system permission. Those are separate decisions with their own seams
 * (grant-service.ts) and their own refusal copy (grant-copy.ts). A grant is bound to the action id class it was
 * approved for, so a grant for "create a note" never covers any other action. Pure: no I/O, no state.
 *
 * Lifetimes are ASSUMED defaults (no owner decision names them) and are injectable. Each is bounded.
 */
import type { DesktopActionRequest, DesktopAdapterId } from '@shared/desktop-actions'
import type { VoiceActionClass } from '@shared/voice/catalog'

/** One action (the default), one task lineage (G06), or one conversation session (G28). */
export const GRANT_SCOPE_KINDS = ['action', 'task', 'conversation'] as const
export type GrantScopeKind = (typeof GRANT_SCOPE_KINDS)[number]

/**
 * Only these classes may ever skip the confirm card. Send, type and delete always confirm, and a read already
 * runs at once so it needs no grant. A grant is therefore never a way to widen what runs without asking.
 */
export const GRANTABLE_CLASSES = ['reversible', 'create'] as const
export type GrantableClass = (typeof GRANTABLE_CLASSES)[number]

export function isGrantableClass(actionClass: VoiceActionClass | null): actionClass is GrantableClass {
  return actionClass === 'reversible' || actionClass === 'create'
}

/**
 * Actions that stay confirm-every-time although their class is grantable (ASSUMED, owner may lift it): the shutter
 * press photographs the person at the keyboard, which is more than creating a file.
 */
export const NEVER_GRANTED_ACTIONS: ReadonlySet<DesktopAdapterId> = new Set(['desktop.photo_booth_capture'])

export function isGrantableAction(request: DesktopActionRequest, actionClass: VoiceActionClass | null): boolean {
  return isGrantableClass(actionClass) && !NEVER_GRANTED_ACTIONS.has(request.id)
}

/** Why a grant ended. */
export const GRANT_REVOKE_REASONS = [
  'stop',
  'sign_out',
  'owner_switch',
  'lock_or_suspend',
  'task_end',
  'conversation_end',
  'user_revoked',
  'expired'
] as const
export type GrantRevokeReason = (typeof GRANT_REVOKE_REASONS)[number]

/** The renderer window and sign-in generation a grant was approved under. Both come from main, never the renderer. */
export interface GrantOwner {
  readonly webContentsId: number
  readonly authGeneration: number
}

/** Opaque, main-owned ids of the task lineage root and the conversation. Either may be absent (G28 seam). */
export interface GrantScopeContext {
  readonly taskLineageId?: string
  readonly conversationId?: string
}

export type GrantBinding =
  | { readonly kind: 'action'; readonly argsHash: string }
  | { readonly kind: 'task'; readonly taskLineageId: string }
  | { readonly kind: 'conversation'; readonly conversationId: string }

export interface ActionGrant {
  readonly grantId: string
  readonly binding: GrantBinding
  /** The action id class: a grant for one action id never covers another. */
  readonly actionId: DesktopAdapterId
  readonly actionClass: GrantableClass
  readonly owner: GrantOwner
  readonly issuedAt: number
  readonly expiresAt: number
}

/** Renderer-safe view of a grant: no args hash, no request data, no scope ids. */
export interface GrantSummary {
  readonly grantId: string
  readonly scope: GrantScopeKind
  readonly actionId: DesktopAdapterId
  readonly actionClass: GrantableClass
  readonly expiresAt: number
}

/** ASSUMED lifetimes (ms). An action grant is a pre-approval for one exact request and lapses quickly. */
export const DEFAULT_GRANT_TTL_MS: Readonly<Record<GrantScopeKind, number>> = {
  action: 60_000,
  task: 30 * 60_000,
  conversation: 60 * 60_000
}
/** No grant outlives a day, whatever is injected. */
export const MAX_GRANT_TTL_MS = 24 * 60 * 60_000
/** Live grants held at once. */
export const GRANT_LIMIT = 32
/** Longest scope id accepted from main's context seams. */
export const GRANT_SCOPE_ID_MAX_CHARS = 128

export type GrantAuditEvent = 'grant.issued' | 'grant.revoked' | 'grant.decision'
/** Metadata only: closed enums and an action id. Never a title, a query, an args hash or spoken words. */
export type GrantAudit = (event: GrantAuditEvent, metadata: Record<string, string>) => void

export function grantSummary(grant: ActionGrant): GrantSummary {
  return {
    grantId: grant.grantId,
    scope: grant.binding.kind,
    actionId: grant.actionId,
    actionClass: grant.actionClass,
    expiresAt: grant.expiresAt
  }
}
