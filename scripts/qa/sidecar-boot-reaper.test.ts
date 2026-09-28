import { describe, expect, it } from 'vitest'
import { hasAtLeastEvent, observedReapedOrphan, parseSidecarRegistry, registryHasSpawnedPid } from './sidecar-boot-reaper.mjs'

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
})
