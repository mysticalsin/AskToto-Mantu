import { createHash } from 'node:crypto'
import type { AccountRef, ConnectorKind } from '@shared/connector-catalog'

/**
 * Typed seam for G61 (opaque multi-account ids). Today every kind has exactly one account, so the resolver hands out one
 * stable opaque ref per kind. A ref is derived from the kind only: it carries no email, tenant or provider id.
 */
export interface AccountResolver {
  /** Null when the kind has no account to act as. */
  resolve(kind: ConnectorKind): AccountRef | null
}

export function opaqueAccountRef(kind: ConnectorKind, slot: string): AccountRef {
  return `acct_${createHash('sha256').update(`connector-account:${kind}:${slot}`).digest('hex').slice(0, 16)}` as AccountRef
}

export const singleAccountResolver: AccountResolver = {
  resolve: (kind) => opaqueAccountRef(kind, 'primary')
}
