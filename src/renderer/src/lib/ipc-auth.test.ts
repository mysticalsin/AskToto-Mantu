import { describe, expect, it } from 'vitest'
import { UNAUTHENTICATED_RESULT } from '@shared/ipc-auth'
import { IPC_UNAUTHENTICATED_EVENT, authenticatedIpcResult, isUnauthenticatedResult } from './ipc-auth'

describe('M2-0249 renderer IPC auth helper', () => {
  it('normalizes the shared unauthenticated result for a migrated write-up handler', () => {
    expect(isUnauthenticatedResult(UNAUTHENTICATED_RESULT)).toBe(true)
    expect(authenticatedIpcResult(UNAUTHENTICATED_RESULT)).toBeUndefined()
    expect(authenticatedIpcResult({ status: 'unlicensed' })).toEqual({ status: 'unlicensed' })
  })

  it('emits one renderer-local event when a migrated IPC returns unauthenticated', () => {
    const events: Event[] = []
    window.addEventListener(IPC_UNAUTHENTICATED_EVENT, (event) => events.push(event))

    authenticatedIpcResult(UNAUTHENTICATED_RESULT)

    expect(events).toHaveLength(1)
    expect((events[0] as CustomEvent).detail).toEqual(UNAUTHENTICATED_RESULT)
  })
})
