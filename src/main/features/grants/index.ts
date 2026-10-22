/** Public surface of the grants feature (G31). Other modules reach it only through this file. */
export {
  createActionGrantService,
  grantRevokeReasonForHardStop,
  grantRevokeReasonForLifecycle,
  NOT_METERED,
  type ActionGrantService,
  type ActionGrantServiceDeps,
  type GrantedRunDecision,
  type PurchaseSeam,
  type PurchaseVerdict
} from './grant-service'
export {
  GRANT_REFUSAL_COPY,
  refusalFor,
  type GrantDecisionKind,
  type GrantRefusal,
  type GrantRefusalReason
} from './grant-copy'
export {
  GRANT_SCOPE_KINDS,
  GRANTABLE_CLASSES,
  isGrantableAction,
  type ActionGrant,
  type GrantAudit,
  type GrantAuditEvent,
  type GrantOwner,
  type GrantRevokeReason,
  type GrantScopeContext,
  type GrantScopeKind,
  type GrantSummary
} from './grant-model'
export type { GrantIssueResult } from './grant-store'
export {
  createOsPermissionSeam,
  type OsPermissionProbes,
  type OsPermissionSeam,
  type OsPermissionVerdict
} from './os-permission-seam'
export { endedTaskLineageRoots, taskLineageRootId } from './task-lineage'
