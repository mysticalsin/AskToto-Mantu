import { describe, expect, it } from 'vitest'
import { MetisCommandCancellationSchema, MetisCommandConfirmationSchema } from './metis-command-contract'

const pair = { proposalId: 'a'.repeat(32), nonce: 'b'.repeat(64) }

describe('Metis command IPC contract', () => {
  it('requires the args hash on confirmation so a nonce alone cannot approve', () => {
    expect(MetisCommandConfirmationSchema.safeParse({ ...pair, argsHash: 'c'.repeat(64) }).success).toBe(true)
    expect(MetisCommandConfirmationSchema.safeParse(pair).success).toBe(false)
    expect(MetisCommandConfirmationSchema.safeParse({ ...pair, argsHash: 'C'.repeat(64) }).success).toBe(false)
    expect(MetisCommandConfirmationSchema.safeParse({ ...pair, argsHash: 'c'.repeat(63) }).success).toBe(false)
    expect(MetisCommandConfirmationSchema.safeParse({ ...pair, argsHash: 'c'.repeat(64), extra: 1 }).success).toBe(
      false
    )
  })

  it('lets a cancellation carry only the id and nonce', () => {
    expect(MetisCommandCancellationSchema.safeParse(pair).success).toBe(true)
    expect(MetisCommandCancellationSchema.safeParse({ ...pair, argsHash: 'c'.repeat(64) }).success).toBe(false)
  })
})
