import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({
  app: { isPackaged: false, getName: () => 'asktoto', hasSingleInstanceLock: () => false }
}))
import { RootRegistry, type RootScopeBinding } from './root-registry'
import {
  hasCompiledQaPersistenceRunStamp,
  newQaPersistenceBootChallenge,
  verifyQaPersistenceLaunchEnvelope
} from './qa-run-protocol'

describe('hosted persistence QA run protocol', () => {
  it('keeps ordinary source and shipping builds without a compiled hosted-run pin', () => {
    expect(hasCompiledQaPersistenceRunStamp()).toBe(false)
  })

  it('refuses challenge issuance in the shipping test build and rejects malformed envelopes', () => {
    expect(() => newQaPersistenceBootChallenge()).toThrow('QA_RUN_NOT_QA_BUILD')
    const challenge = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    expect(verifyQaPersistenceLaunchEnvelope(Buffer.from('{'), challenge)).toBeNull()
    expect(
      verifyQaPersistenceLaunchEnvelope(
        Buffer.from(
          '{"schema":"metis-persistence-qa-launch-envelope/v1","schema":"forged","payload":"e30","signature":"AA"}'
        ),
        challenge
      )
    ).toBeNull()
    expect(verifyQaPersistenceLaunchEnvelope(Buffer.from('{}'), 'caller-supplied')).toBeNull()
  })

  it('rejects a supplied QA run option in shipping before scope or base callbacks', async () => {
    let scopeCallbacks = 0
    let baseCallbacks = 0
    const roots = new RootRegistry({
      qaProfileOwner: Object.freeze({}) as never,
      userDataRoot: () => {
        baseCallbacks += 1
        return '/tmp/qa-shipping-refusal'
      },
      resolveScope: (_scope): RootScopeBinding | undefined => {
        scopeCallbacks += 1
        return undefined
      },
      bindGatewayRoot: async () => undefined
    })
    await expect(roots.openExisting(Object.freeze({}), 'fixture-meeting')).rejects.toThrow(
      'QA persistence run is unavailable in a shipping build'
    )
    expect(scopeCallbacks).toBe(0)
    expect(baseCallbacks).toBe(0)
  })
})
