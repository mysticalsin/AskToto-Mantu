import { describe, expect, it } from 'vitest'
import { UNAUTHENTICATED_RESULT } from '@shared/ipc-auth'
import { authenticatedIpcResult, isUnauthenticatedResult } from './ipc-auth'

describe('M2-0249 renderer IPC auth helper', () => {
  it('normalizes the shared unauthenticated result for a migrated write-up handler', () => {
    expect(isUnauthenticatedResult(UNAUTHENTICATED_RESULT)).toBe(true)
    expect(authenticatedIpcResult(UNAUTHENTICATED_RESULT)).toBeUndefined()
    expect(authenticatedIpcResult({ status: 'unlicensed' })).toEqual({ status: 'unlicensed' })
  })
})
