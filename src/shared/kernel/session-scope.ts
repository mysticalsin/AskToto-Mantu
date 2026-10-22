import { z } from 'zod'
import { ContractError, canonical, copyData, freezeData, requireCondition } from './contract-data'

/** A tenant, user and session tuple. Every kernel fact is bound to exactly one scope. */
export interface SessionScope {
  readonly tenantId: string
  readonly userId: string
  readonly sessionId: string
}

const ScopeIdSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/)
const SCOPE_KEYS = 'sessionId,tenantId,userId'

const ScopeSchema = z.object({ tenantId: ScopeIdSchema, userId: ScopeIdSchema, sessionId: ScopeIdSchema }).strict()

/** Validates and freezes a scope. Unknown keys fail with SCOPE_SHAPE, bad identifiers with SCOPE_ID. */
export function validateScope(scope: unknown): SessionScope {
  const clean = copyData(scope)
  requireCondition(
    typeof clean === 'object' &&
      clean !== null &&
      !Array.isArray(clean) &&
      Object.keys(clean).sort().join(',') === SCOPE_KEYS,
    'SCOPE_SHAPE'
  )
  const parsed = ScopeSchema.safeParse(clean)
  if (!parsed.success) throw new ContractError('SCOPE_ID')
  return freezeData(parsed.data)
}

export function assertSameScope(expected: unknown, actual: unknown): void {
  requireCondition(canonical(validateScope(expected)) === canonical(validateScope(actual)), 'SCOPE_MISMATCH')
}

/**
 * Builds the kernel scope from the trusted owner-session ref plus the caller's meeting or session id.
 * The owner ref's own `sessionId` is a per-sign-in id and is deliberately not used here.
 */
export function sessionScopeFor(
  ref: { readonly tenantKey: string; readonly ownerKey: string },
  sessionId: string
): SessionScope {
  return validateScope({ tenantId: ref.tenantKey, userId: ref.ownerKey, sessionId })
}
