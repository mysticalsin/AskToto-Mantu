import { describe, expect, it } from 'vitest'
import {
  combinedReport,
  hasAtLeastEvent,
  observedReapedOrphan,
  parseSidecarRegistry,
  registryHasSpawnedPid,
  summarizeProof
} from './sidecar-boot-reaper.mjs'

describe('sidecar boot reaper proof helpers', () => {
  it('waits for the spawned identity record for the exact orphan pid before hard-killing main', () => {
    const records = parseSidecarRegistry(
      [
        JSON.stringify({ kind: 'intent', name: 'llama-server', pid: 9001 }),
        'not json',
        JSON.stringify({ kind: 'spawned', name: 'llama-server', pid: 4242 }),
        JSON.stringify({ kind: 'spawned', name: 'llama-server', pid: 5151 })
      ].join('\n')
    )

    expect(registryHasSpawnedPid(records, 4242)).toBe(true)
    expect(registryHasSpawnedPid(records, 9001)).toBe(false)
    expect(registryHasSpawnedPid(records, 1111)).toBe(false)
  })

  it('can accept an orphan already reaped before the second boot audit becomes observable', () => {
    const records = [
      { event: 'app.started' },
      { event: 'sidecar.reaped', pid: 4242, reason: 'registry' }
    ]

    expect(hasAtLeastEvent(records, 'app.started', 2)).toBe(false)
    expect(observedReapedOrphan(records, 4242, () => false)).toBe('registry')
    expect(observedReapedOrphan(records, 5151, () => false)).toBeNull()
    expect(observedReapedOrphan(records, 4242, () => true)).toBeNull()
  })

  it('ships when the stand-in proof passes and the real llama-server variant is externally blocked', () => {
    const standIn = summarizeProof({
      kind: 'stand-in-registry',
      result: 'pass',
      failures: [],
      unblock: null,
      timingsMs: { firstReady: 1, sidecarStarted: 2, reaped: 3 },
      pids: { firstMain: 10, sidecar: 11, secondMain: 12 },
      reapedReason: 'registry',
      events: { 'sidecar.reaped': 1 },
      processes: { beforeKill: {}, afterReaper: {} }
    })
    const realLlama = summarizeProof({
      kind: 'real-llama-server',
      result: 'BLOCKED_EXTERNAL',
      failures: ['Seed the packaged local model assets.'],
      unblock: 'Seed the packaged local model assets.',
      timingsMs: { firstReady: null, sidecarStarted: null, reaped: null },
      pids: { firstMain: null, sidecar: null, secondMain: null },
      reapedReason: null,
      events: {},
      processes: { beforeKill: null, afterReaper: null }
    })

    expect(combinedReport(standIn, realLlama)).toMatchObject({
      result: 'pass',
      externalBlockers: [{ kind: 'real-llama-server', unblock: 'Seed the packaged local model assets.' }]
    })
  })
})
