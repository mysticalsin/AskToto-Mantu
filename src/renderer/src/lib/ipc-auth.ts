import { UNAUTHENTICATED_RESULT, type UnauthenticatedResult } from '@shared/ipc-auth'

export const IPC_UNAUTHENTICATED_EVENT = 'metis:ipc-unauthenticated'

export function isUnauthenticatedResult(value: unknown): value is UnauthenticatedResult {
  return !!value &&
    typeof value === 'object' &&
    (value as UnauthenticatedResult).ok === false &&
    (value as UnauthenticatedResult).code === UNAUTHENTICATED_RESULT.code
}

export function authenticatedIpcResult<T>(value: T | UnauthenticatedResult): T | undefined {
  if (!isUnauthenticatedResult(value)) return value
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
    window.dispatchEvent(new CustomEvent(IPC_UNAUTHENTICATED_EVENT, { detail: value }))
  }
  return undefined
}
