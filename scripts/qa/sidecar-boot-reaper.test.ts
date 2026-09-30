import { describe, expect, it } from 'vitest'
import {
  combinedReport,
  hasAtLeastEvent,
  launchEnv,
  observedReapedOrphan,
  parseMacHelperProcInfo,
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

  it('preserves the real llama-server boot-reaper evidence fields from the original proof', () => {
    const realLlama = summarizeProof({
      kind: 'real-llama-server',
      result: 'pass',
      failures: [],
      unblock: null,
      timingsMs: { firstReady: 1, sidecarStarted: 2, llamaStarted: 2, reaped: 3 },
      pids: { firstMain: 10, sidecar: 11, orphan: 11, secondMain: 12 },
      reapedReason: 'registry',
      events: { 'sidecar.reaped': 1 },
      processes: { beforeKill: {}, afterReaper: {} }
    })

    expect(realLlama.timingsMs).toMatchObject({ sidecarStarted: 2, llamaStarted: 2 })
    expect(realLlama.pids).toMatchObject({ sidecar: 11, orphan: 11 })
  })

  it('passes the requested supervision through to the launch env and leaves it to the build default otherwise', () => {
    expect(launchEnv('/tmp/p', { METIS_SUPERVISION: 'off' })).toMatchObject({
      ASKTOTO_USERDATA: '/tmp/p',
      METIS_DISABLE_APPLE_FM: '1',
      METIS_SUPERVISION: 'off'
    })
    expect((launchEnv('/tmp/p') as NodeJS.ProcessEnv).METIS_SUPERVISION).toBe(process.env.METIS_SUPERVISION)
  })

  it('records the requested supervision in a proof summary that carries one, and omits it otherwise', () => {
    const base = {
      kind: 'real-llama-server',
      result: 'pass',
      failures: [],
      unblock: null,
      timingsMs: {},
      pids: {},
      reapedReason: 'registry',
      events: {},
      processes: {}
    }
    expect(summarizeProof({ ...base, supervision: 'off' }).supervision).toBe('off')
    expect('supervision' in summarizeProof(base)).toBe(false)
  })

  it('preserves a stand-in argv element containing spaces exactly, the way KERN_PROCARGS2 does but a re-split ps command column cannot', () => {
    const stdout = `${JSON.stringify({
      pid: 4242,
      ppid: 1,
      pgid: 4242,
      osStartTime: '2026-01-01T00:00:00.000Z',
      exeRealpath: '/usr/local/bin/node',
      args: ['/usr/local/bin/node', '-e', 'setInterval(() => {}, 1000)']
    })}\n`

    const identity = parseMacHelperProcInfo(stdout)
    if (!identity) throw new Error('expected a parsed identity')

    expect(identity).toMatchObject({ pid: 4242, ppid: 1, pgid: 4242, exeRealpath: '/usr/local/bin/node' })
    expect(identity.args).toEqual(['/usr/local/bin/node', '-e', 'setInterval(() => {}, 1000)'])
  })

  it('rejects proc-info output that is not JSON or is missing a required identity field', () => {
    expect(parseMacHelperProcInfo('')).toBeNull()
    expect(parseMacHelperProcInfo('not json')).toBeNull()
    expect(parseMacHelperProcInfo(JSON.stringify({ pid: 4242, osStartTime: '2026-01-01T00:00:00.000Z' }))).toBeNull()
    expect(
      parseMacHelperProcInfo(JSON.stringify({ pid: 4242, osStartTime: '2026-01-01T00:00:00.000Z', exeRealpath: '/bin/x', args: 'not-an-array' }))
    ).toBeNull()
  })
})
