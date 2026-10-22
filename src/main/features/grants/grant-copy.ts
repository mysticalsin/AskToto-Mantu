/**
 * Refusal copy for the three separate decisions (G31). Every reason has its own fixed line, written from templates,
 * never from the request or the transcript. No line blames the person, and none claims something ran.
 *
 *   allowance  "Métis asks before it does this": the user has not said yes to this kind of action in this scope.
 *   purchase   the plan or quota: metering is a typed seam (G79/G80), so a line exists only for a real verdict.
 *   permission the operating system has not allowed Métis to do it: macOS Privacy & Security (G10 probes).
 */
export type AllowanceReason = 'no_grant' | 'not_grantable' | 'grant_expired' | 'source_not_trusted'
export type PurchaseReason = 'quota_exhausted' | 'quota_unavailable'
export type PermissionReason = 'permission_denied' | 'permission_unverified'
export type GrantRefusalReason = AllowanceReason | PurchaseReason | PermissionReason
export type GrantDecisionKind = 'allowance' | 'purchase' | 'permission'

export const DECISION_OF_REASON: Readonly<Record<GrantRefusalReason, GrantDecisionKind>> = {
  no_grant: 'allowance',
  not_grantable: 'allowance',
  grant_expired: 'allowance',
  source_not_trusted: 'allowance',
  quota_exhausted: 'purchase',
  quota_unavailable: 'purchase',
  permission_denied: 'permission',
  permission_unverified: 'permission'
}

export const GRANT_REFUSAL_COPY: Readonly<Record<GrantRefusalReason, string>> = {
  no_grant: 'Métis asks before it does this. Approve the card to continue.',
  not_grantable: 'This kind of action always asks first, even after you approve similar ones.',
  grant_expired: 'Your earlier approval has ended. Approve the card to continue.',
  source_not_trusted: 'A wake word never starts an action by itself. Approve the card to continue.',
  quota_exhausted: 'Your plan has no room left for this action, so nothing was run.',
  quota_unavailable: 'Métis could not check your plan just now, so nothing was run.',
  permission_denied:
    'macOS has not allowed Métis to do this yet. Turn it on in System Settings under Privacy & Security, then try again. Nothing was run.',
  permission_unverified:
    'Métis could not confirm macOS allows this, so it is asking first. Approve the card to continue.'
}

/** The permission refusal names where to turn it on. `target` is a fixed label from the requirement table. */
export function permissionDeniedCopy(target: string): string {
  return `macOS has not allowed Métis to use ${target} yet. Turn it on in System Settings under Privacy & Security, then try again. Nothing was run.`
}

export interface GrantRefusal {
  readonly decision: GrantDecisionKind
  readonly reason: GrantRefusalReason
  readonly copy: string
}

export function refusalFor(reason: GrantRefusalReason, copy?: string): GrantRefusal {
  return { decision: DECISION_OF_REASON[reason], reason, copy: copy ?? GRANT_REFUSAL_COPY[reason] }
}
