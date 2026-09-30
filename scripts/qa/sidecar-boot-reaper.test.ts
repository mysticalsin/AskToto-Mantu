import { describe, expect, it } from 'vitest'
import {
  combinedReport,
  exitCodeFor,
  hasAtLeastEvent,
  hostFloorOverrides,
  launchEnv,
  legacyOrphanVerdict,
  observedLegacyReap,
  observedReapedOrphan,
  parseCliArgs,
  parseMacHelperProcInfo,
  parseSidecarRegistry,
  registryHasSpawnedPid,
  summarizeProof
} from './sidecar-boot-reaper.mjs'

function proof(kind: string, result: string, unblock: string | null = null) {
  return summarizeProof({
    kind,
    result,
    failures: result === 'pass' ? [] : [unblock ?? 'a failure'],
    unblock,
    timingsMs: {},
    pids: {},
    reapedReason: null,
    events: {},
    processes: { beforeKill: null, afterReaper: null }
  })
}

const ORPHAN = 4242
const CONTROL = 5151
const legacyReaped = [
  { event: 'app.started' },
  { event: 'sidecar.reaped', name: 'llama-server', pid: ORPHAN, reason: 'legacy-orphan' }
]

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
    expect(launchEnv(process.env, '/tmp/p', { extraEnv: { METIS_SUPERVISION: 'off' } })).toMatchObject({
      ASKTOTO_USERDATA: '/tmp/p',
      METIS_DISABLE_APPLE_FM: '1',
      METIS_SUPERVISION: 'off'
    })
    expect((launchEnv(process.env, '/tmp/p') as NodeJS.ProcessEnv).METIS_SUPERVISION).toBe(process.env.METIS_SUPERVISION)
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

  it('sets METIS_QA_HOST_FLOOR_OVERRIDE=1 only for the real llama-server launch, on the isolated profile, without keys', () => {
    const base = { PATH: '/usr/bin', OPENAI_API_KEY: 'k', METIS_QA_HOST_FLOOR_OVERRIDE: '1' }
    const real = launchEnv(base, '/tmp/profile', { hostFloorOverride: true })
    expect(real).toMatchObject({ ASKTOTO_USERDATA: '/tmp/profile', METIS_DISABLE_APPLE_FM: '1', METIS_QA_HOST_FLOOR_OVERRIDE: '1' })
    expect(real).not.toHaveProperty('OPENAI_API_KEY')

    // The stand-in launch never carries it, even when the runner's own env does.
    expect(launchEnv(base, '/tmp/profile')).not.toHaveProperty('METIS_QA_HOST_FLOOR_OVERRIDE')
    expect(launchEnv(base, '/tmp/profile', { hostFloorOverride: false })).not.toHaveProperty('METIS_QA_HOST_FLOOR_OVERRIDE')
  })

  it('records hostFloorOverride, the host memory and only the floor figures from the app audit', () => {
    const records = [
      { event: 'app.started' },
      { event: 'local.host-floor-override', floor: 'advertised-ram', hostTotalBytes: 7516192768, hostAvailableBytes: 3221225472, actor: 'someone' },
      { event: 'local.host-floor-override', floor: 'model.gguf',hostTotalBytes: 'n', hostAvailableBytes: 1 }
    ]
    expect(hostFloorOverrides(records)).toEqual([
      { floor: 'advertised-ram', hostTotalBytes: 7516192768, hostAvailableBytes: 3221225472 },
      { floor: 'unknown', hostTotalBytes: null, hostAvailableBytes: 1 }
    ])

    const hostMemory = { hwMemsizeBytes: 7516192768, totalmemBytes: 7516192768, freememBytes: 1 }
    const realLlama = summarizeProof({
      kind: 'real-llama-server',
      result: 'pass',
      failures: [],
      unblock: null,
      timingsMs: { firstReady: 1, sidecarStarted: 2, llamaStarted: 2, reaped: 3 },
      pids: { firstMain: 10, sidecar: 11, orphan: 11, secondMain: 12 },
      reapedReason: 'registry',
      events: {},
      processes: { beforeKill: {}, afterReaper: {} },
      hostFloorOverride: true,
      hostMemory,
      hostFloorOverrides: hostFloorOverrides(records).slice(0, 1)
    })
    expect(realLlama).toMatchObject({
      hostFloorOverride: true,
      hostMemory,
      hostFloorOverrides: [{ floor: 'advertised-ram', hostTotalBytes: 7516192768, hostAvailableBytes: 3221225472 }]
    })
    expect(summarizeProof({ kind: 'stand-in-registry', result: 'pass' })).toMatchObject({
      hostFloorOverride: false,
      hostMemory: null,
      hostFloorOverrides: []
    })
  })

  it('exits 2 for a BLOCKED_EXTERNAL real llama-server row only under --require-real-llama', () => {
    const blocked = combinedReport(
      proof('stand-in-registry', 'pass'),
      proof('real-llama-server', 'BLOCKED_EXTERNAL', 'Seed the packaged local model assets.'),
      proof('legacy-orphan', 'pass')
    )
    expect(blocked.result).toBe('pass')
    expect(exitCodeFor(blocked)).toBe(0)
    expect(exitCodeFor(blocked, { requireRealLlama: false })).toBe(0)
    expect(exitCodeFor(blocked, { requireRealLlama: true })).toBe(2)

    const allPass = combinedReport(proof('stand-in-registry', 'pass'), proof('real-llama-server', 'pass'), proof('legacy-orphan', 'pass'))
    expect(exitCodeFor(allPass, { requireRealLlama: true })).toBe(0)

    // A failing row is a FAIL with or without the flag, never a PRECONDITION.
    const failed = combinedReport(
      proof('stand-in-registry', 'pass'),
      proof('real-llama-server', 'BLOCKED_EXTERNAL', 'Seed the packaged local model assets.'),
      proof('legacy-orphan', 'fail')
    )
    expect(exitCodeFor(failed, { requireRealLlama: true })).toBe(1)
    expect(exitCodeFor(failed)).toBe(1)
  })

  it('reads --require-real-llama from the command line and refuses anything else', () => {
    expect(parseCliArgs(['Metis.app', 'out/report.json'])).toEqual({
      target: 'Metis.app',
      reportPath: 'out/report.json',
      requireRealLlama: false
    })
    expect(parseCliArgs(['Metis.app', 'out/report.json', '--require-real-llama'])).toEqual({
      target: 'Metis.app',
      reportPath: 'out/report.json',
      requireRealLlama: true
    })
    expect(() => parseCliArgs(['Metis.app'])).toThrow(/usage/)
    expect(() => parseCliArgs(['Metis.app', 'r.json', '--require-real'])).toThrow(/usage/)
  })

  it('passes the legacy-orphan row only for a legacy-orphan reap of the seeded pid within 5 s while the control survives', () => {
    const observation = { records: legacyReaped, orphanPid: ORPHAN, controlPid: CONTROL, reapedMs: 1200, orphanAlive: false, controlAlive: true }
    expect(legacyOrphanVerdict(observation)).toEqual({ result: 'pass', failures: [] })
    expect(legacyOrphanVerdict({ ...observation, reapedMs: 0 }).result).toBe('pass')

    const notReaped = 'seeded llama-server orphan was not reaped as legacy-orphan within 5 s of boot'
    // A registry reap of the same pid does not isolate the legacy rule.
    const registry = [{ event: 'sidecar.reaped', name: 'llama-server', pid: ORPHAN, reason: 'registry' }]
    expect(legacyOrphanVerdict({ ...observation, records: registry })).toEqual({ result: 'fail', failures: [notReaped] })
    expect(legacyOrphanVerdict({ ...observation, records: [{ event: 'app.started' }] }).failures).toEqual([notReaped])
    expect(legacyOrphanVerdict({ ...observation, reapedMs: 5001 }).failures).toEqual([notReaped])
    expect(legacyOrphanVerdict({ ...observation, reapedMs: null }).failures).toEqual([notReaped])
    expect(legacyOrphanVerdict({ ...observation, orphanAlive: true }).failures).toEqual([notReaped])
    const otherPid = [{ event: 'sidecar.reaped', name: 'llama-server', pid: 9999, reason: 'legacy-orphan' }]
    expect(legacyOrphanVerdict({ ...observation, records: otherPid }).failures).toEqual([notReaped])
  })

  it('fails the legacy-orphan row when the negative control is reaped or gone', () => {
    const observation = { records: legacyReaped, orphanPid: ORPHAN, controlPid: CONTROL, reapedMs: 800, orphanAlive: false, controlAlive: true }
    const controlReaped = [...legacyReaped, { event: 'sidecar.reaped', name: 'llama-server', pid: CONTROL, reason: 'legacy-orphan' }]
    expect(legacyOrphanVerdict({ ...observation, records: controlReaped, controlAlive: false })).toEqual({
      result: 'fail',
      failures: ['negative control llama-server was reaped although its model is outside the profile local-llm']
    })
    expect(legacyOrphanVerdict({ ...observation, controlAlive: false })).toEqual({
      result: 'fail',
      failures: ['negative control llama-server was not alive after the boot reaper ran']
    })
  })

  it('observes a legacy reap only for a dead pid audited by name llama-server with reason legacy-orphan', () => {
    expect(observedLegacyReap(legacyReaped, ORPHAN, () => false)).toBe(true)
    expect(observedLegacyReap(legacyReaped, ORPHAN, () => true)).toBe(false)
    expect(observedLegacyReap([{ event: 'sidecar.reaped', name: 'fm-serve', pid: ORPHAN, reason: 'legacy-orphan' }], ORPHAN, () => false)).toBe(false)
  })

  it('reports the Windows shape as PASS exactly when the stand-in passes, listing both macOS-only rows as blockers', () => {
    const realLlama = proof('real-llama-server', 'BLOCKED_EXTERNAL', 'Seed the packaged local model assets.')
    const legacy = proof('legacy-orphan', 'BLOCKED_EXTERNAL', 'Run the legacy-orphan proof on a macOS hosted runner; it is macOS-only.')
    const passing = combinedReport(proof('stand-in-registry', 'pass'), realLlama, legacy)
    expect(passing).toMatchObject({
      schema: 3,
      result: 'pass',
      proofs: { legacyOrphan: { kind: 'legacy-orphan', result: 'BLOCKED_EXTERNAL' } },
      externalBlockers: [
        { kind: 'real-llama-server', unblock: 'Seed the packaged local model assets.' },
        { kind: 'legacy-orphan', unblock: 'Run the legacy-orphan proof on a macOS hosted runner; it is macOS-only.' }
      ]
    })
    expect(exitCodeFor(passing)).toBe(0)
    const failing = combinedReport(proof('stand-in-registry', 'fail'), realLlama, legacy)
    expect(failing.result).toBe('fail')
    expect(exitCodeFor(failing)).toBe(1)
  })

  it('keeps the legacy-orphan summary content-free: pids, timings, counts and the control verdict only', () => {
    const summary = summarizeProof({
      kind: 'legacy-orphan',
      result: 'pass',
      failures: [],
      unblock: null,
      timingsMs: { modelSeeded: 4000, orphansHealthy: 3000, appStarted: 9000, reaped: 400 },
      pids: { orphan: ORPHAN, control: CONTROL, main: 7000 },
      reapedReason: 'legacy-orphan',
      events: { 'sidecar.reaped': 1 },
      processes: { beforeKill: null, afterReaper: {} },
      negativeControl: { alive: true, reaped: false }
    })
    expect(summary).toMatchObject({ negativeControl: { alive: true, reaped: false }, pids: { orphan: ORPHAN, control: CONTROL } })
    expect(JSON.stringify(summary)).not.toMatch(/[\\/]/)
    expect('negativeControl' in summarizeProof({ kind: 'stand-in-registry', result: 'pass' })).toBe(false)
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
