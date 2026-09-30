import { describe, expect, it } from 'vitest'
import { parseVmStatAvailableBytes } from '../../src/main/llm/available-memory'
import {
  advertisedRamFloorRefuses,
  availableBytesFromVmStat,
  createProfilePlan,
  exitCodeForReportResult,
  finalSigtermVerdict,
  keepWaitingForScenario,
  launchEnv,
  PREWARM_MIN_FREE_RAM_GB,
  prewarmFreeRamFloorPasses,
  removeTempDir,
  reportResultForRows,
  runMemorySummary,
  runtimeRoleVerdict,
  scenarioEvidence,
  sharedProfileRelaunchVerdict,
  scenarioStillStarting,
  setupFailure,
  supervisedColdStartVerdict,
  unreapedDeadRegistryCount,
  UNRELATED_FIXTURE_LIFETIME_MS
} from './hk-m.mjs'

describe('HK-M temp directory cleanup', () => {
  it('requests retries and does not turn a one-off ENOTEMPTY into a failure', () => {
    const warnings: { code: string; message: string }[] = []
    let calls = 0
    const options: unknown[] = []
    const remove = (_dir: unknown, opts?: unknown) => {
      options.push(opts)
      calls += 1
      if (calls === 1) throw Object.assign(new Error('ENOTEMPTY: directory not empty'), { code: 'ENOTEMPTY' })
    }

    expect(removeTempDir('/tmp/metis-hk-m-x', warnings, remove)).toBe(false)
    expect(removeTempDir('/tmp/metis-hk-m-x', warnings, remove)).toBe(true)
    expect(options[0]).toEqual({ recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    expect(warnings).toEqual([{ code: 'ENOTEMPTY', message: 'ENOTEMPTY: directory not empty' }])

    const rows = [{ scenario: 'idle', cycle: 1, status: 'PASS' }]
    expect(reportResultForRows(rows)).toBe('pass')
  })

  it('still reports a real survivor as a failure', () => {
    const rows = [{ scenario: 'idle', cycle: 1, status: 'FAIL', failure: 'owned_processes_survived' }]
    expect(reportResultForRows(rows)).toBe('fail')
  })
})

describe('HK-M profile modes', () => {
  it('keeps fresh mode on a per-row profile marked for immediate cleanup', () => {
    const removed: string[] = []
    let next = 0
    const plan = createProfilePlan({
      profileMode: 'fresh',
      makeProfile: () => `/tmp/profile-${++next}`,
      remove: (dir: string) => {
        removed.push(dir)
        return true
      }
    })

    const first = plan.profileForRow()
    expect(first).toEqual({ profile: '/tmp/profile-1', removeAfterRow: true })
    expect(plan.profileForRow()).toEqual({ profile: '/tmp/profile-2', removeAfterRow: true })
    expect(plan.cleanup()).toBe(false)
    expect(removed).toEqual([])
  })

  it('reuses one shared profile across rows and removes it only at the end', () => {
    const removed: string[] = []
    let next = 0
    const plan = createProfilePlan({
      profileMode: 'shared',
      makeProfile: () => `/tmp/shared-${++next}`,
      remove: (dir: string) => {
        removed.push(dir)
        return true
      }
    })

    expect(plan.profileForRow()).toEqual({ profile: '/tmp/shared-1', removeAfterRow: false })
    expect(plan.profileForRow()).toEqual({ profile: '/tmp/shared-1', removeAfterRow: false })
    expect(removed).toEqual([])
    expect(plan.cleanup()).toBe(true)
    expect(removed).toEqual(['/tmp/shared-1'])
    expect(plan.cleanup()).toBe(false)
  })
})

const modelSidecar ={ pid: 101, ppid: 100, startedMs: 1001, exe: '/tmp/llama-server', role: 'llama-server' }
const renderer = { pid: 102, ppid: 100, startedMs: 1002, exe: '/tmp/Metis Helper', role: 'Metis Helper (Renderer)' }
const ffmpeg = { pid: 103, ppid: 100, startedMs: 1003, exe: '/tmp/ffmpeg', role: 'ffmpeg' }

describe('HK-M scenario evidence', () => {
  it('does not accept an ordinary Electron child as model-starting proof', () => {
    const proof = scenarioEvidence('model-starting', {
      records: [],
      registry: [],
      sidecars: [renderer]
    })

    expect(proof).toMatchObject({
      ok: false,
      status: 'BLOCKED_EXTERNAL',
      failure: 'scenario_not_triggered'
    })
  })

  it('fails model-starting when the audit trigger is present but the model sidecar role is absent', () => {
    const proof = scenarioEvidence('model-starting', {
      records: [{ event: 'sidecar.spawn', name: 'llama-server' }],
      registry: [],
      sidecars: [renderer]
    })

    expect(proof).toMatchObject({
      ok: false,
      status: 'FAIL',
      failure: 'expected_model_sidecar_absent'
    })
  })

  it('accepts model-starting only with local runtime audit evidence and the model sidecar role', () => {
    const proof = scenarioEvidence('model-starting', {
      records: [{ event: 'local.runtime.start' }],
      registry: [],
      sidecars: [renderer, modelSidecar]
    })

    expect(proof).toMatchObject({ ok: true })
  })

  it('requires active-inference, ffmpeg-import, and registry-write scenario markers', () => {
    expect(
      scenarioEvidence('active-inference', {
        records: [{ event: 'local.runtime.start' }],
        registry: [],
        sidecars: [modelSidecar]
      })
    ).toMatchObject({ ok: false, status: 'BLOCKED_EXTERNAL', failure: 'scenario_not_triggered' })

    expect(
      scenarioEvidence('ffmpeg-import', {
        records: [{ event: 'hk-m.ffmpeg-import' }],
        registry: [],
        sidecars: [ffmpeg]
      })
    ).toMatchObject({ ok: true })

    expect(
      scenarioEvidence('registry-write', {
        records: [{ event: 'hk-m.registry-write' }],
        registry: [{ kind: 'intent', name: 'llama-server' }],
        sidecars: [modelSidecar]
      })
    ).toMatchObject({ ok: true })
  })
})

describe('HK-M report result', () => {
  it('is pass only when every live row passes', () => {
    expect(reportResultForRows([{ status: 'PASS' }, { status: 'PASS' }])).toBe('pass')
    expect(exitCodeForReportResult('pass')).toBe(0)
  })

  it('keeps blocked rows non-passing so the CI acceptance lane fails without 20/20 live proof', () => {
    const result = reportResultForRows([{ status: 'PASS' }, { status: 'BLOCKED_EXTERNAL' }])

    expect(result).toBe('blocked')
    expect(exitCodeForReportResult(result)).toBe(1)
  })

  it('fails when a row was not run, so an exhausted budget can never read as a pass', () => {
    const result = reportResultForRows([{ status: 'PASS' }, { status: 'NOT_RUN' }])

    expect(result).toBe('fail')
    expect(exitCodeForReportResult(result)).toBe(1)
  })

  it('fails when any row fails', () => {
    const result = reportResultForRows([{ status: 'PASS' }, { status: 'FAIL' }, { status: 'BLOCKED_EXTERNAL' }])

    expect(result).toBe('fail')
    expect(exitCodeForReportResult(result)).toBe(1)
  })
})

const wrapper = { pid: 100, ppid: 1, startedMs: 1000, exe: '/tmp/metis-mac-helper', role: 'metis-mac-helper' }
const supervisedModel = { pid: 101, ppid: 100, startedMs: 1001, exe: '/tmp/llama-server', role: 'llama-server' }

describe('HK-M relaunch runtime counts', () => {
  it('accepts no runtime when the row started none, and exactly one when it started a model', () => {
    expect(runtimeRoleVerdict([renderer], false)).toMatchObject({ ok: true, counts: {} })
    expect(runtimeRoleVerdict([renderer, modelSidecar], true)).toMatchObject({ ok: true, counts: { 'llama-server': 1 } })
  })

  it('fails a duplicated runtime role even when none was expected', () => {
    const duplicate = { ...modelSidecar, pid: 201 }
    expect(runtimeRoleVerdict([modelSidecar, duplicate], false)).toMatchObject({
      ok: false,
      failure: 'duplicate_runtime_after_relaunch'
    })
    expect(runtimeRoleVerdict([modelSidecar, duplicate], true)).toMatchObject({
      ok: false,
      failure: 'duplicate_runtime_after_relaunch'
    })
  })

  it('fails a model row whose relaunch never brought a runtime back', () => {
    expect(runtimeRoleVerdict([renderer], true)).toMatchObject({ ok: false, failure: 'runtime_missing_after_relaunch' })
  })

  it('fails when two different runtime roles are alive', () => {
    const fm = { pid: 301, ppid: 100, startedMs: 1005, exe: '/tmp/fm', role: 'fm' }
    expect(runtimeRoleVerdict([modelSidecar, fm], true)).toMatchObject({
      ok: false,
      failure: 'multiple_runtime_roles_after_relaunch'
    })
  })
})

describe('HK-M shared-profile relaunch checks', () => {
  const main = { pid: 100, ppid: 50, startedMs: 1000, exe: '/tmp/Metis', role: 'Metis' }
  const orphan = { ...modelSidecar, pid: 404, ppid: 1 }

  it('fails a shared-profile row when an owned process is orphaned after relaunch', () => {
    expect(
      sharedProfileRelaunchVerdict({
        owned: [main, orphan],
        registry: [],
        records: [],
        table: [main, orphan],
        previousDeadRegistryCount: 0
      })
    ).toMatchObject({
      ok: false,
      failure: 'shared_profile_orphan_after_relaunch',
      evidence: { orphans: { 'llama-server': 1 } }
    })
  })

  it('fails when more than one local runtime role is alive after relaunch', () => {
    const fm = { pid: 105, ppid: 100, startedMs: 1005, exe: '/tmp/fm', role: 'fm' }
    expect(
      sharedProfileRelaunchVerdict({
        owned: [main, modelSidecar, fm],
        registry: [],
        records: [],
        table: [main, modelSidecar, fm],
        previousDeadRegistryCount: 0
      })
    ).toMatchObject({
      ok: false,
      failure: 'shared_profile_multiple_runtimes_after_relaunch',
      evidence: { runtimeTotal: 2 }
    })
  })

  it('counts unreaped dead-pid registry entries and fails when the count rises across cycles', () => {
    const registry = [
      { kind: 'spawned', name: 'llama-server', pid: 201 },
      { kind: 'spawned', name: 'llama-server', pid: 202 },
      { kind: 'spawned', name: 'llama-server', pid: 203 }
    ]
    const records = [{ event: 'sidecar.reaped', pid: 202, reason: 'registry' }]
    const table = [{ pid: 203, ppid: 100, startedMs: 1003, exe: '/tmp/llama-server', role: 'llama-server' }]

    expect(unreapedDeadRegistryCount({ registry, records, table })).toBe(1)
    expect(
      sharedProfileRelaunchVerdict({
        owned: [main],
        registry,
        records,
        table,
        previousDeadRegistryCount: 0
      })
    ).toMatchObject({
      ok: false,
      failure: 'shared_profile_unreaped_dead_registry_entries_grew',
      evidence: { deadRegistry: 1 }
    })
  })

  it('records the dead registry count when the shared-profile relaunch is clean', () => {
    expect(
      sharedProfileRelaunchVerdict({
        owned: [main],
        registry: [{ kind: 'spawned', name: 'llama-server', pid: 201 }],
        records: [],
        table: [main],
        previousDeadRegistryCount: null
      })
    ).toMatchObject({ ok: true, deadRegistry: 1, evidence: { deadRegistry: 1, runtimeTotal: 0 } })
  })
})

describe('HK-M shared-profile final SIGTERM check', () => {
  it('passes only when the final SIGTERM launch leaves no owned survivors', () => {
    expect(finalSigtermVerdict([])).toEqual({ ok: true, survivors: {} })
    expect(finalSigtermVerdict([modelSidecar])).toEqual({
      ok: false,
      failure: 'final_sigterm_owned_processes_survived',
      survivors: { 'llama-server': 1 }
    })
  })
})

describe('HK-M launch environment', () => {
  const baseEnv = {
    PATH: '/usr/bin',
    METIS_SUPERVISION: 'off',
    METIS_SIDECAR_SUPERVISION: '0',
    OPENAI_API_KEY: 'k'
  }

  it('shipped mode strips both supervision variables so the build default decides', () => {
    const env = launchEnv({ baseEnv, profile: '/tmp/p', scenario: 'idle', supervisionMode: 'shipped' })
    expect('METIS_SUPERVISION' in env).toBe(false)
    expect('METIS_SIDECAR_SUPERVISION' in env).toBe(false)
    expect(env).toMatchObject({
      PATH: '/usr/bin',
      ASKTOTO_USERDATA: '/tmp/p',
      METIS_DISABLE_APPLE_FM: '1',
      METIS_HK_M_SCENARIO: 'idle'
    })
    expect('OPENAI_API_KEY' in env).toBe(false)
  })

  it('forced-on mode sets METIS_SUPERVISION=on and drops the legacy variable', () => {
    const env = launchEnv({ baseEnv, profile: '/tmp/p', scenario: 'idle', supervisionMode: 'forced-on' })
    expect(env.METIS_SUPERVISION).toBe('on')
    expect('METIS_SIDECAR_SUPERVISION' in env).toBe(false)
  })
})

describe('HK-M supervised cold start', () => {
  const healthy = [{ event: 'local.runtime.start' }]

  it('passes when llama-server runs under the supervise wrapper without a fallback', () => {
    expect(
      supervisedColdStartVerdict({
        records: healthy,
        sidecars: [wrapper, supervisedModel],
        table: [wrapper, supervisedModel],
        requireHealthy: true
      })
    ).toEqual({ ok: true })
  })

  it('fails a llama-server that was spawned directly by main', () => {
    const main = { pid: 50, ppid: 1, startedMs: 900, exe: '/tmp/Metis', role: 'Metis' }
    const direct = { ...supervisedModel, ppid: 50 }
    expect(
      supervisedColdStartVerdict({ records: healthy, sidecars: [direct], table: [main, direct], requireHealthy: true })
    ).toEqual({ ok: false, failure: 'runtime_not_supervised' })
  })

  it('fails a default-off build in shipped mode with runtime_not_supervised', () => {
    const main = { pid: 50, ppid: 1, startedMs: 900, exe: '/tmp/Metis', role: 'Metis' }
    const direct = { ...supervisedModel, ppid: 50 }
    const env = launchEnv({
      baseEnv: { METIS_SUPERVISION: 'on' },
      profile: '/tmp/p',
      scenario: 'idle',
      supervisionMode: 'shipped'
    })
    expect(env.METIS_SUPERVISION).toBeUndefined()
    expect(
      supervisedColdStartVerdict({ records: healthy, sidecars: [direct], table: [main, direct], requireHealthy: true })
    ).toEqual({ ok: false, failure: 'runtime_not_supervised' })
  })

  it('fails when the audit log records a fallback to direct spawn', () => {
    expect(
      supervisedColdStartVerdict({
        records: [...healthy, { event: 'sidecar.unsupervised' }],
        sidecars: [supervisedModel],
        table: [wrapper, supervisedModel],
        requireHealthy: true
      })
    ).toEqual({ ok: false, failure: 'sidecar_unsupervised_fallback' })
  })

  it('demands health only when asked', () => {
    const input = { records: [], sidecars: [supervisedModel], table: [wrapper, supervisedModel] }
    expect(supervisedColdStartVerdict({ ...input, requireHealthy: false })).toEqual({ ok: true })
    expect(supervisedColdStartVerdict({ ...input, requireHealthy: true })).toEqual({
      ok: false,
      failure: 'supervised_cold_start_unhealthy'
    })
  })
})

describe('HK-M scenario waiting', () => {
  it('keeps waiting for a missing marker or a sidecar that is not visible yet, but not for other failures', () => {
    expect(scenarioStillStarting({ ok: false, status: 'BLOCKED_EXTERNAL', failure: 'scenario_not_triggered' })).toBe(true)
    expect(scenarioStillStarting({ ok: false, status: 'FAIL', failure: 'expected_model_sidecar_absent' })).toBe(true)
    expect(scenarioStillStarting({ ok: false, status: 'FAIL', failure: 'expected_ffmpeg_sidecar_absent' })).toBe(false)
    expect(scenarioStillStarting({ ok: true })).toBe(false)
  })
})

describe('HK-M setup failure', () => {
  const blocked = { ok: false, status: 'BLOCKED_EXTERNAL', failure: 'scenario_not_triggered' }
  const refused = [{ event: 'app.renderer.ready' }, { event: 'hk-m.setup-failed', row: 'model-starting', error: 'InsufficientRamError' }]

  it('ends a waiting row as soon as the app reports its setup failed, naming only the Error class', () => {
    expect(setupFailure(refused)).toBe('setup_failed:InsufficientRamError')
    expect(keepWaitingForScenario(blocked, refused)).toBe(false)
    expect(keepWaitingForScenario(blocked, [{ event: 'app.renderer.ready' }])).toBe(true)
  })

  it('never copies anything but an identifier into the failure', () => {
    expect(setupFailure([{ event: 'hk-m.setup-failed', error: '/private/tmp/model.gguf missing' }])).toBe('setup_failed:Error')
    expect(setupFailure([{ event: 'hk-m.setup-failed' }])).toBe('setup_failed:Error')
    expect(setupFailure([{ event: 'local.runtime.start' }])).toBeNull()
  })

  it('does not end a row whose proof already holds', () => {
    expect(keepWaitingForScenario({ ok: true }, refused)).toBe(false)
    expect(scenarioStillStarting({ ok: true })).toBe(false)
  })

  it('counts the refused-start evidence per row', () => {
    const records = [
      ...refused,
      { event: 'local.runtime.missing' },
      { event: 'hk-m.ram-floor-override' }
    ]
    const proof = scenarioEvidence('model-starting', { records, registry: [], sidecars: [renderer] })
    expect(proof.evidence.audit).toMatchObject({ localRuntimeMissing: 1, hkSetupFailed: 1, hkRamFloorOverride: 1 })
  })

  it('no longer blames the bundle in the model-row unblock text', () => {
    for (const scenario of ['model-starting', 'active-inference']) {
      const proof = scenarioEvidence(scenario, { records: [], registry: [], sidecars: [] })
      expect(proof.status).toBe('BLOCKED_EXTERNAL')
      expect(proof.unblock).not.toMatch(/packaged and intact|bundled local model/)
      expect(proof.unblock).toMatch(/hk-m\.setup-failed/)
    }
  })
})

describe('HK-M host memory evidence', () => {
  const GIB = 1024 ** 3
  const vmStat = [
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
    'Pages free:                               10000.',
    'Pages active:                             90000.',
    'Pages inactive:                           80000.',
    'Pages speculative:                         5000.',
    'Pages throttled:                              0.',
    'Pages wired down:                         70000.',
    'Pages purgeable:                           1000.'
  ].join('\n')

  it('reads available memory from vm_stat exactly as the app does', () => {
    expect(availableBytesFromVmStat(vmStat)).toBe(96_000 * 16384)
    expect(availableBytesFromVmStat(vmStat)).toBe(parseVmStatAvailableBytes(vmStat))
    expect(availableBytesFromVmStat('garbage')).toBeNull()
  })

  it('flags the advertised-RAM floor on a 7 GiB runner and not on an 8 GB-class one', () => {
    expect(advertisedRamFloorRefuses(7 * GIB)).toBe(true)
    expect(advertisedRamFloorRefuses(8e9)).toBe(false)
    expect(advertisedRamFloorRefuses(8 * GIB)).toBe(false)
  })

  it('applies the localPrewarm free-memory floor', () => {
    expect(PREWARM_MIN_FREE_RAM_GB).toBe(4)
    expect(prewarmFreeRamFloorPasses(3.9 * GIB)).toBe(false)
    expect(prewarmFreeRamFloorPasses(4 * GIB)).toBe(true)
  })

  it('summarizes override rows with the host memory and the rows the prewarm floor refused', () => {
    const host = { totalmemBytes: 7 * GIB, hwMemsizeBytes: 7 * GIB, advertisedRamGB: 7 }
    const rows = [
      { scenario: 'idle', memoryAtStart: { prewarmFreeRamFloorPasses: true } },
      { scenario: 'model-starting', memoryAtStart: { prewarmFreeRamFloorPasses: false }, evidence: { audit: { hkRamFloorOverride: 1 } } },
      { scenario: 'active-inference', memoryAtStart: { prewarmFreeRamFloorPasses: false }, evidence: { audit: { hkRamFloorOverride: 1 } } },
      { scenario: 'ffmpeg-import', status: 'NOT_RUN' }
    ]
    expect(runMemorySummary(host, rows)).toEqual({
      ramFloorOverride: { rows: 2, totalmemBytes: 7 * GIB, hwMemsizeBytes: 7 * GIB, advertisedRamGB: 7 },
      prewarmFloor: { minFreeRamGB: 4, rowsSampled: 3, rowsRefused: 2 }
    })
  })
})

describe('HK-M same-name fixture', () => {
  // Cause of the model-row failures: the reaper matches by exe realpath and registry identity, never by name, so the
  // fixture (a temp copy of sleep) was not killed by the app; its former 60 s lifetime expired during a slow model load.
  it('outlives the ready wait, the scenario wait and the survivor bound', () => {
    expect(UNRELATED_FIXTURE_LIFETIME_MS).toBeGreaterThan(150_000 + 240_000 + 5_000)
  })
})
