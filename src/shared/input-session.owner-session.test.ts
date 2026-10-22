import { describe, expect, it } from 'vitest'
import { INPUT_SESSION_STOP_REASONS, InputSessionStopReasonSchema, OwnerSessionRefSchema } from '@shared/input-session'

describe('input-session owner-session contract adoption', () => {
  it('stop reasons include renderer-reset and arbitration-preempted', () => {
    expect(InputSessionStopReasonSchema.safeParse('renderer-reset').success).toBe(true)
    expect(InputSessionStopReasonSchema.safeParse('arbitration-preempted').success).toBe(true)
    expect(InputSessionStopReasonSchema.safeParse('auth-changed').success).toBe(false)
    expect(INPUT_SESSION_STOP_REASONS.slice(-2)).toEqual(['renderer-reset', 'arbitration-preempted'])
  })

  it('re-exports owner-session contracts', () => {
    const parsed = OwnerSessionRefSchema.safeParse({
      v: 1,
      ownerKey: 'cd'.repeat(32),
      tenantKey: 'ef'.repeat(32),
      authGeneration: 0,
      sessionId: '123e4567-e89b-42d3-a456-426614174000',
      frameOwner: '4:9',
      contextRevision: 0,
      issuedAt: 1_700_000_000_000
    })
    expect(parsed.success).toBe(true)
  })
})
