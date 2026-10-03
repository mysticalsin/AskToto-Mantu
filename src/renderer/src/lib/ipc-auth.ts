import { UNAUTHENTICATED_RESULT, type UnauthenticatedResult } from '@shared/ipc'

export function isUnauthenticatedResult(value: unknown): value is UnauthenticatedResult {
  return !!value &&
    typeof value === 'object' &&
    (value as UnauthenticatedResult).ok === false &&
    (value as UnauthenticatedResult).code === UNAUTHENTICATED_RESULT.code
}

export function authenticatedIpcResult<T>(value: T | UnauthenticatedResult): T | undefined {
  return isUnauthenticatedResult(value) ? undefined : value
}

